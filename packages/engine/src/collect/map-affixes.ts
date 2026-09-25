/**
 * The map's `Players` affixes, on the character's own sheet.
 *
 *     statContexts.addAll(CommonStatUtils.addMapAffixStats(entity));
 *
 * — `StatCalculation`, for every entity, checked in the 6.4.13 jar. For a player that is the
 * map's affixes whose `affected` is `Players`: `fire_minus_res`, `minus_armor`, `ele_weakness`
 * and the rest. They are yours for as long as you stand in the map, so they belong in the same
 * container as your gear rather than beside it. See `damage/map.ts` for the roll and the level.
 */

import type { BuildDoc } from "@cte2/schema";

import { context, type Env, type StatContext } from "../context.js";
import { fightLevel, mapPlayerMods } from "../damage/map.js";

export function collectMapAffixes(env: Env, build: BuildDoc): StatContext[] {
  const map = build.config?.map;
  if (map === undefined) return [];
  const mods = mapPlayerMods(env.snapshot, env.index, env.balance, map, fightLevel(build), env.report);

  // One context per affix rather than one for the map, so a breakdown row names the affix that
  // took your fire resist rather than "the map". They sum in the container either way.
  const byAffix = new Map<string, StatContext>();
  for (const mod of mods) {
    let ctx = byAffix.get(mod.source);
    if (ctx === undefined) {
      ctx = context("MOB_AFFIX", mod.source, "config.map.affixes", []);
      byAffix.set(mod.source, ctx);
    }
    ctx.stats.push({ statId: mod.statId, type: mod.type, value: mod.value });
  }
  return [...byAffix.values()];
}
