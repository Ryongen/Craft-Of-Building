/**
 * The map: its tier, its affixes, and the mob's own element damage that rides the same sweep.
 *
 * The arithmetic is the game's, read out of `Mine_and_Slash-1.20.1-6.4.13.jar`: `getTierStats`
 * for the tier, `rarityForTier` and `reconcileAffixes` for the roll, `addMapAffixStats` for which
 * side each affix lands on.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BuildDoc } from "@cte2/schema";
import { mapRarityForTier, maxMapTier } from "@cte2/schema";

import { resolveEffects } from "../calculate.js";
import { ENGINE_BALANCE, baseStats, closeTo, damageStat, engineSnapshot, exact, statEntry } from "../test-support.js";
import { defence } from "./defence.js";
import { mapAffixIds, mapAffixRoll, mapTierBonus } from "./map.js";
import { balance } from "../balance.js";

const ADDITIVE = {
  effects: ["_additive_damage_number_add_stat_data"],
  events: ["on_damage"],
  order: "damage_layers",
  side: "Source",
};

/** Two map bands, and a Unique that must never be picked for a tier — its band is 0-100. */
const RARITIES = {
  common: {
    id: "common",
    type: "NORMAL",
    item_tier: 0,
    min_affixes: 1,
    map_tiers: { min: 0, max: 10 },
    stat_percents: { min: 0, max: 17 },
  },
  rare: {
    id: "rare",
    type: "NORMAL",
    item_tier: 2,
    min_affixes: 3,
    map_tiers: { min: 21, max: 40 },
    stat_percents: { min: 35, max: 51 },
  },
  unique: {
    id: "unique",
    type: "UNIQUE",
    item_tier: 5,
    min_affixes: 0,
    map_tiers: { min: 100, max: 100 },
    stat_percents: { min: 0, max: 100 },
  },
};

const MAP_AFFIXES = {
  fire_minus_res: {
    id: "fire_minus_res",
    affected: "Players",
    req: "",
    weight: 1000,
    stats: [{ type: "FLAT", min: -20, max: -40, stat: "fire_resist" }],
  },
  fire_res: {
    id: "fire_res",
    affected: "Mobs",
    req: "",
    weight: 1000,
    stats: [{ type: "FLAT", min: 30, max: 60, stat: "fire_resist" }],
  },
  prophecy_hp: {
    id: "prophecy_hp",
    affected: "Players",
    req: "prophecy",
    weight: 1000,
    stats: [{ type: "MORE", min: -20, max: -20, stat: "health" }],
  },
  extra_mob_drops: {
    id: "extra_mob_drops",
    affected: "Mobs",
    req: "",
    weight: 0,
    stats: [{ type: "FLAT", min: 50, max: 50, stat: "extra_mob_drops" }],
  },
};

function snapshotWith(player: Record<string, number> = { health: 1000 }, extra: Record<string, Record<string, unknown>> = {}) {
  return engineSnapshot({
    ...extra,
    mmorpg_game_balance: {
      original_balance: { ...ENGINE_BALANCE, DMG_MOB_BONUS_PER_MAP_TIER: 0.03, HP_MOB_BONUS_PER_MAP_TIER: 0.095 },
    },
    mmorpg_base_stats: {
      original_mode_player: baseStats(
        "original_mode_player",
        Object.entries(player).map(([id, value]) => exact(id, "FLAT", value)),
      ),
    },
    mmorpg_gear_rarity: RARITIES,
    mmorpg_map_affix: MAP_AFFIXES,
    mmorpg_stat: {
      fire_resist: statEntry("fire_resist"),
      all_elemental_damage: damageStat("all_elemental_damage", {
        ele: "Elemental",
        effect: [{ ...ADDITIVE, ifs: ["ele_match_stat"] }],
      }),
      total_damage: damageStat("total_damage", { ele: "ALL", effect: [{ ...ADDITIVE, ifs: [] }] }),
    },
    mmorpg_stat_effect: {
      _additive_damage_number_add_stat_data: {
        id: "_additive_damage_number_add_stat_data",
        ser: "modify_stat_layer",
        layer: "additive_damage",
        modification: "ADD",
        number_to_modify: "number",
        number_provider: { type: "STAT_DATA", calc: "" },
        number_modifiers: [],
      },
    },
    mmorpg_stat_condition: { ele_match_stat: { id: "ele_match_stat", ser: "ele_match_stat" } },
  });
}

function doc(config: BuildDoc["config"]): BuildDoc {
  return { schemaVersion: 1, character: { level: 1 }, config } as BuildDoc;
}

const row = (r: ReturnType<typeof defence>, element: string) => r.byElement.find((e) => e.element === element)!;

test("a tier picks its rarity the way `rarityForTier` does, and the roll is that band's middle", () => {
  const snapshot = snapshotWith();
  // The Unique's 100-100 band must not win tier 100 on `item_tier` — only `NORMAL` rarities are
  // maps, and the top of those is rare's 40.
  assert.equal(maxMapTier(snapshot), 40);
  assert.equal(mapRarityForTier(snapshot, 5)?.id, "common");
  // Tier 15 falls in the gap between the bands, and `rarityForTier` takes the highest band that
  // starts at or below it rather than none.
  assert.equal(mapRarityForTier(snapshot, 15)?.id, "common");
  assert.equal(mapRarityForTier(snapshot, 30)?.id, "rare");

  closeTo(mapAffixRoll(snapshot, { tier: 30 }), (35 + 51) / 2);
  closeTo(mapAffixRoll(snapshot, { tier: 30, affixRoll: 90 }), 90, "a stated roll is used as stated");

  // `getTierStats`: `tier × PER_TIER × 100`, both MORE.
  const bonus = mapTierBonus(balance(snapshot), 20);
  closeTo(bonus.health, 190);
  closeTo(bonus.damage, 60);
});

test("only affixes a map can roll are offered", () => {
  // `reconcileAffixes` filters on an empty `req`, and a weight of 0 never comes out of the
  // weighted roll.
  assert.deepEqual(mapAffixIds(snapshotWith()), ["fire_minus_res", "fire_res"]);
});

test("a Players affix lands on your own sheet, at the tier's roll", () => {
  // The free starting resists would be noise here, as they are in `defence.test.ts`.
  const snapshot = snapshotWith({ health: 1000, fire_resist: 50 });
  // Rare band midpoint 43: `-20 + (-40 - -20) × 0.43` = -28.6.
  const inMap = resolveEffects(doc({ map: { tier: 30, affixes: ["fire_minus_res", "fire_res"] } }), snapshot, {
    newbieResists: false,
  });
  closeTo(inMap.stats.get("fire_resist")?.value ?? 0, 50 - 28.6);

  // `fire_res` is a Mobs affix and must not reach the character at all.
  const mobOnly = resolveEffects(doc({ map: { tier: 30, affixes: ["fire_res"] } }), snapshot, {
    newbieResists: false,
  });
  closeTo(mobOnly.stats.get("fire_resist")?.value ?? 0, 50);
});

test("a mob's element damage makes its elemental hits bigger, and leaves physical alone", () => {
  // `mmorpg_base_stats/mob`'s `all_elemental_damage 50`: additive damage on a hit whose element
  // matches `Elemental`, which is fire, cold and lightning and not physical.
  const snapshot = snapshotWith();
  const result = defence(doc({ enemy: { level: 1, offence: { elementDamage: { elemental: 50 } } } }), snapshot, {
    hitSize: 1000,
    newbieResists: false,
  });
  closeTo(row(result, "Physical").taken, 1);
  closeTo(row(result, "Fire").taken, 1.5);
  closeTo(row(result, "Cold").taken, 1.5);
  closeTo(row(result, "Fire").effectiveHealth, 1000 / 1.5);
});

test("a map tier sizes the over-time hit and leaves effective HP alone", () => {
  // Tier 30 is `MORE total_damage` of 90 on this balance. It makes every hit bigger alike, so it
  // is in `takenFromSwing` and not in `taken`.
  const snapshot = snapshotWith();
  const result = defence(doc({ enemy: { level: 1 }, map: { tier: 30 } }), snapshot, {
    hitSize: 1000,
    newbieResists: false,
  });
  closeTo(row(result, "Physical").taken, 1);
  closeTo(row(result, "Physical").takenFromSwing, 1.9);
  closeTo(row(result, "Physical").effectiveHealth, 1000);
});

test("total damage and element damage add, rather than multiply", () => {
  // Both write the same `additive_damage` layer: a mob with 25 `total_damage` (`savage`) and 50
  // on elemental hits swings a fire hit at +75%, not x1.5 x 1.25.
  const snapshot = snapshotWith(
    { health: 1000 },
    {
      mmorpg_mob_affix: {
        savage: {
          id: "savage",
          type: "prefix",
          format: "RED",
          stats: [{ type: "FLAT", min: 25, max: 25, stat: "total_damage" }],
        },
      },
    },
  );
  const savage = defence(
    doc({ enemy: { level: 1, offence: { elementDamage: { elemental: 50 } }, affixes: ["savage"] } }),
    snapshot,
    { hitSize: 1000, newbieResists: false },
  );
  closeTo(row(savage, "Fire").taken, 1.5, "savage stays out of effective HP");
  closeTo(row(savage, "Fire").takenFromSwing, 1.75);
  closeTo(row(savage, "Physical").takenFromSwing, 1.25);
});
