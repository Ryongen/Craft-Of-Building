/**
 * `mmorpg_map_affix` and the map tier — what a map does to the fight.
 *
 * A map is not only a harder mob. `StatCalculation` calls `CommonStatUtils.addMapAffixStats` for
 * **every** entity standing in one, players included, and `MapItemData.getStatAndContext` hands
 * each entity the affixes whose `affected` names its side:
 *
 *     for (MapAffixData affix : this.getAllAffixesThatAffect(AffectedEntities.of(en))) {
 *         stats.addAll(affix.getAffix().getStats(affix.p, getLevel()));
 *     }
 *     return Arrays.asList(new SimpleStatCtx(StatContext.StatCtxType.MOB_AFFIX, stats));
 *
 * So `fire_res` lands on the mob you are hitting and `fire_minus_res` lands on you, and a planner
 * that modelled only the first would flatter every build in a hard map. Both halves are here:
 * {@link mapMobMods} for the enemy's sheet, {@link mapPlayerMods} for the character's.
 *
 * ## The tier
 *
 * Verified in `Mine_and_Slash-1.20.1-6.4.13.jar`, not only the fork. `MapItemData.getTierStats`:
 *
 *     stats.add(ExactStatData.noScaling((float) (HP_MOB_BONUS_PER_MAP_TIER * tier * 100F), MORE, Health.GUID()));
 *     stats.add(ExactStatData.noScaling((float) (DMG_MOB_BONUS_PER_MAP_TIER * tier * 100F), MORE, TOTAL_DAMAGE));
 *
 * — reaching every non-summon mob through `MobStatUtils.addMapTierStats`. On `original_balance`
 * that is 9.5% more health and 3% more damage a tier, so a tier 100 mob has ×10.5 the health and
 * ×4 the damage of the same mob outside.
 *
 * The tier also decides how hard the affixes roll. `setTier` re-derives the map's rarity from its
 * tier (`rarityForTier`: the `NORMAL` rarity with the highest `map_tiers.min` at or below it),
 * and `MapBlueprint.reconcileAffixes` rolls each affix at that rarity's band:
 *
 *     int percent = rarity.stat_percents.random();
 *     map.affixes.add(new MapAffixData(affix, percent));
 *
 * A tier 90 map is mythic and rolls 86-100; a tier 5 map is common and rolls 0-17. Without a
 * stated roll this reads the middle of the band, which is the average of `random()`.
 */

import type { Snapshot } from "@cte2/extractor";
import type { BuildDoc, MapSetup, Severity } from "@cte2/schema";
import { CATEGORY, entry, ids as registryIds, mapRarityForTier, maxMapTier } from "@cte2/schema";

import type { Balance } from "../balance.js";
import { parseRolledMods, rollToExact, type ModType } from "../modifier.js";
import type { StatIndex } from "../stat-def.js";

/** `AffectedEntities` — which side of the fight an affix lands on. */
export type MapAffixSide = "Mobs" | "Players" | "All";

/** One map affix, as the registry declares it. */
export type MapAffixView = {
  id: string;
  affected: MapAffixSide;
  /**
   * Non-empty means the affix is not rolled onto maps at all — `reconcileAffixes` filters on
   * `x.req.isEmpty()`. In this pack every such entry is `prophecy`.
   */
  req: string;
  /** `RandomUtils.weightedRandom` weight. Zero never rolls. */
  weight: number;
  stats: Record<string, unknown>[];
};

export function mapAffix(snapshot: Snapshot, id: string): MapAffixView | undefined {
  const d = entry(snapshot, CATEGORY.mapAffix, id)?.data;
  if (!d) return undefined;
  const affected = d["affected"];
  return {
    id,
    affected: affected === "Players" || affected === "All" ? affected : "Mobs",
    req: typeof d["req"] === "string" ? d["req"] : "",
    weight: typeof d["weight"] === "number" ? d["weight"] : 0,
    stats: Array.isArray(d["stats"])
      ? d["stats"].filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
      : [],
  };
}

/** Whether `reconcileAffixes` can ever put this affix on a map. */
export function isRollableMapAffix(affix: MapAffixView): boolean {
  return affix.req === "" && affix.weight > 0;
}

/** Every affix a map can roll, sorted, for a picker. */
export function mapAffixIds(snapshot: Snapshot): string[] {
  return registryIds(snapshot, CATEGORY.mapAffix)
    .filter((id) => {
      const affix = mapAffix(snapshot, id);
      return affix !== undefined && isRollableMapAffix(affix);
    })
    .sort();
}

/** The map's tier, clamped the way `setTier` clamps it. */
export function mapTierOf(snapshot: Snapshot, map: MapSetup | undefined): number {
  const tier = Math.trunc(map?.tier ?? 0);
  return Math.min(Math.max(tier, 0), maxMapTier(snapshot));
}

/**
 * The roll every affix is read at: the stated one, or the middle of the tier's rarity band.
 *
 * A stated roll outside the band is used as stated — asking "what if this rolled high" is a fair
 * question — and `validate.ts` says the game would not make it.
 */
export function mapAffixRoll(snapshot: Snapshot, map: MapSetup | undefined): number {
  if (map?.affixRoll !== undefined && Number.isFinite(map.affixRoll)) {
    return Math.min(Math.max(map.affixRoll, 0), 100);
  }
  const band = mapRarityForTier(snapshot, mapTierOf(snapshot, map))?.statPercents;
  return band === undefined ? 0 : (band.min + band.max) / 2;
}

/** `getTierStats` as two percentages — both `MORE`, both `noScaling`. */
export function mapTierBonus(bal: Balance, tier: number): { health: number; damage: number } {
  return {
    health: bal.hpMobBonusPerMapTier * tier * 100,
    damage: bal.dmgMobBonusPerMapTier * tier * 100,
  };
}

/** What one map affix or the tier contributes, resolved. */
export type MapMod = { statId: string; type: ModType; value: number; source: string };

/** The id the tier's two stats are reported under. */
export const MAP_TIER_SOURCE = "map_tier";

function affixMods(
  snapshot: Snapshot,
  index: StatIndex,
  bal: Balance,
  map: MapSetup | undefined,
  level: number,
  side: "Mobs" | "Players",
  report: (severity: Severity, code: string, path: string, message: string) => void,
): MapMod[] {
  const out: MapMod[] = [];
  const roll = mapAffixRoll(snapshot, map);
  const seen = new Set<string>();

  for (const id of map?.affixes ?? []) {
    // `reconcileAffixes` never rolls one twice, so a repeat is counted once.
    if (seen.has(id)) continue;
    seen.add(id);

    const affix = mapAffix(snapshot, id);
    if (!affix) {
      // Reported once, from the mob side, so the two passes do not say it twice.
      if (side === "Mobs") {
        report(
          "warning",
          "unknown-map-affix",
          "config.map.affixes",
          `No \`${CATEGORY.mapAffix}\` entry "${id}", so it contributed nothing.`,
        );
      }
      continue;
    }
    if (affix.affected !== side && affix.affected !== "All") continue;

    for (const mod of parseRolledMods(affix.stats)) {
      // `getStats(p, getLevel())` — the map's roll, at the map's level.
      const exact = rollToExact(mod, roll, level, index.shapeOf(mod.statId), bal);
      out.push({ statId: exact.statId, type: exact.type, value: exact.value, source: id });
    }
  }
  return out;
}

/**
 * Everything the map puts on a mob: its `Mobs` affixes, and the tier's `MORE health` and
 * `MORE total_damage`.
 *
 * `level` is the map's, which is the mob's — a mob in a map spawns at the map's level.
 */
export function mapMobMods(
  snapshot: Snapshot,
  index: StatIndex,
  bal: Balance,
  map: MapSetup | undefined,
  level: number,
  report: (severity: Severity, code: string, path: string, message: string) => void,
): MapMod[] {
  if (map === undefined) return [];
  const out = affixMods(snapshot, index, bal, map, level, "Mobs", report);
  const tier = mapTierOf(snapshot, map);
  if (tier > 0) {
    const bonus = mapTierBonus(bal, tier);
    out.push({ statId: "health", type: "MORE", value: bonus.health, source: MAP_TIER_SOURCE });
    out.push({ statId: "total_damage", type: "MORE", value: bonus.damage, source: MAP_TIER_SOURCE });
  }
  return out;
}

/** Everything the map puts on the character: its `Players` affixes. The tier touches mobs only. */
export function mapPlayerMods(
  snapshot: Snapshot,
  index: StatIndex,
  bal: Balance,
  map: MapSetup | undefined,
  level: number,
  report: (severity: Severity, code: string, path: string, message: string) => void,
): MapMod[] {
  if (map === undefined) return [];
  return affixMods(snapshot, index, bal, map, level, "Players", report);
}

/** The level mobs in this fight are at — and so the map's, which spawns them at its own. */
export function fightLevel(build: BuildDoc): number {
  return build.config?.enemy?.level ?? build.config?.enemyLevel ?? build.character.level;
}
