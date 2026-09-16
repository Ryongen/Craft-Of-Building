/**
 * Level-up points spent on strength, dexterity and intelligence.
 *
 * The game keeps these as a plain `HashMap<String, Integer>` on `PlayerData.statPoints` and
 * hands them to the stat calculation as one context of its own:
 *
 *     public List<StatContext> getStatAndContext(LivingEntity en) {
 *         var list = map.entrySet().stream().map(x -> {
 *             float val = x.getValue();
 *             ExactStatData stat = ExactStatData.levelScaled(val, ExileDB.Stats()
 *                 .get(x.getKey()), ModType.FLAT, 1);
 *             return stat;
 *         }).collect(Collectors.toList());
 *         return Arrays.asList(new SimpleStatCtx(StatContext.StatCtxType.STAT_POINTS, list));
 *     }
 *
 * — `StatPointsData.java`. Three things in that to keep hold of:
 *
 *  - **The level passed is a literal `1`, not the character's.** `CORE_STAT_SCALING` is
 *    `base_scaling 1 + per_level_scaling 0.05 * (lvl - 1)`, which at level 1 is exactly 1, so
 *    one point is +1 flat at level 2 and at level 100 alike. Levelling raises how many points
 *    you have, never what one is worth. `scaleToLvl: false` below is that literal.
 *  - **The modifier type is always FLAT.** There is no path that allocates a percentage.
 *  - **It is its own context type**, which is why this is a collector rather than something
 *    folded into `collect/base-stats.ts`: a breakdown has to be able to say "40 of your
 *    strength is points you spent" separately from "20 is the shirt".
 *
 * What a point is *worth* is not here at all. `CoreStat.affectStats` expands the stat into its
 * bundle — strength into health, health regen, % armour, attack damage and summon health — and
 * that already happens in `calculate`'s core-stat pass, against the same container, so adding
 * flat strength here is the whole of the job.
 */

import type { BuildDoc } from "@cte2/schema";
import { coreStatIds } from "@cte2/schema";

import { context, type Env, type StatContext } from "../context.js";
import { sourceToExact, type ExactMod } from "../modifier.js";

export function collectStatPoints(env: Env, build: BuildDoc): StatContext[] {
  const allocated = build.character.statPoints;
  if (allocated === undefined) return [];

  const legal = coreStatIds(env.snapshot);
  const mods: ExactMod[] = [];

  for (const [statId, points] of Object.entries(allocated)) {
    const path = `character.statPoints.${statId}`;

    if (!Number.isFinite(points) || points === 0) continue;
    if (points < 0) {
      env.report(
        "error",
        "negative-stat-points",
        path,
        `${points} points allocated. The map is only ever incremented and decremented by one ` +
          `(AllocateStatPacket), so a negative count cannot happen in game and is ignored here.`,
      );
      continue;
    }

    // `AllocateStatPacket.onReceived` refuses anything that is not a `CoreStat`, and an
    // unregistered id falls back to `EmptyStat` rather than throwing — so in game a typo here
    // grants nothing at all. Report it rather than quietly granting a stat the game would not.
    if (legal.length > 0 && !legal.includes(statId)) {
      env.report(
        "warning",
        "not-a-core-stat",
        path,
        `\`${statId}\` is not a core stat, and AllocateStatPacket would have rejected it. ` +
          `Granting nothing. Allocatable: ${legal.join(", ")}.`,
      );
      continue;
    }

    mods.push(
      sourceToExact(
        // `scaleToLvl: false` *is* the hardcoded `1` in `StatPointsData` — one point is one
        // point at every level.
        { statId, type: "FLAT", v1: points, scaleToLvl: false },
        env.level,
        env.index.shapeOf(statId),
        env.balance,
      ),
    );
  }

  if (mods.length === 0) return [];
  return [context("STAT_POINTS", "statPoints", "character.statPoints", mods)];
}
