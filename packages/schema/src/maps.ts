/**
 * A map's tier, as the rarity it implies — shared by validation and the engine.
 *
 * `MapItemData.setTier` re-derives the map's gear rarity from its tier, and that rarity decides
 * how many affixes it carries and how hard they roll. See `damage/map.ts` in the engine for the
 * rest of what a map does.
 */

import type { Snapshot } from "@cte2/extractor";

import { CATEGORY, entry, ids } from "./queries.js";

/** A `NORMAL` gear rarity as a map sees it: its tier band, its roll band, its affix count. */
export type MapRarity = {
  id: string;
  tiers: { min: number; max: number };
  statPercents: { min: number; max: number };
  /** `getAffixAmount()`, which is `min_affixes`. */
  affixCount: number;
};

function minMax(value: unknown): { min: number; max: number } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const min = v["min"];
  const max = v["max"];
  return typeof min === "number" && typeof max === "number" ? { min, max } : undefined;
}

/**
 * The `NORMAL` rarities, the only ones a map can be. Unique and Runeword keep a default 0-100
 * `map_tiers` and would otherwise match every tier — the fork's own comment on `rarityForTier`.
 */
function normalRarities(snapshot: Snapshot): (MapRarity & { itemTier: number })[] {
  const out: (MapRarity & { itemTier: number })[] = [];
  for (const id of ids(snapshot, CATEGORY.gearRarity)) {
    const d = entry(snapshot, CATEGORY.gearRarity, id)?.data;
    if (!d || d["type"] !== "NORMAL") continue;
    const tiers = minMax(d["map_tiers"]);
    const statPercents = minMax(d["stat_percents"]);
    if (!tiers || !statPercents) continue;
    out.push({
      id,
      tiers,
      statPercents,
      affixCount: typeof d["min_affixes"] === "number" ? d["min_affixes"] : 0,
      itemTier: typeof d["item_tier"] === "number" ? d["item_tier"] : 0,
    });
  }
  return out;
}

/**
 * `MapItemData.maxMapTier()` — the top `NORMAL` rarity's `map_tiers.max`. 100 on this pack, and
 * derived rather than written down because the game derives it too.
 */
export function maxMapTier(snapshot: Snapshot): number {
  const tops = normalRarities(snapshot).map((r) => r.tiers.max);
  return tops.length === 0 ? 100 : Math.max(...tops);
}

/**
 * `MapItemData.rarityForTier` — the `NORMAL` rarity whose band holds this tier.
 *
 *     if (r.map_tiers.min > tier) continue;
 *     if (best == null || r.map_tiers.min > best.map_tiers.min
 *             || (r.map_tiers.min == best.map_tiers.min && r.item_tier > best.item_tier)) best = r;
 */
export function mapRarityForTier(snapshot: Snapshot, tier: number): MapRarity | undefined {
  let best: (MapRarity & { itemTier: number }) | undefined;
  for (const r of normalRarities(snapshot)) {
    if (r.tiers.min > tier) continue;
    if (
      best === undefined ||
      r.tiers.min > best.tiers.min ||
      (r.tiers.min === best.tiers.min && r.itemTier > best.itemTier)
    ) {
      best = r;
    }
  }
  if (best === undefined) return undefined;
  const { itemTier: _itemTier, ...rarity } = best;
  return rarity;
}
