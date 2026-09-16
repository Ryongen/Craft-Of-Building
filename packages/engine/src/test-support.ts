/**
 * Synthetic snapshots for the engine's tests.
 *
 * Built on `@cte2/schema`'s helpers, which already model the rarity ladder and the tag
 * vocabulary. What they do not have is `mmorpg_stat` or `mmorpg_base_stats` — schema never
 * needed a stat definition — so this adds those, plus the level-scaling curves that
 * `mmorpg_game_balance` carries and the validator never reads.
 *
 * Values mirror Craft to Exile 2 `2.0.2`: `original_balance` scales NORMAL by 0.2 per level
 * without a cap and CORE by 0.05 per level capped at `MAX_LEVEL`.
 */

import assert from "node:assert/strict";

import type { Snapshot } from "@cte2/extractor";
import { BALANCE, makeSnapshot, type Registries } from "@cte2/schema/test-support";

export * from "@cte2/schema/test-support";

/**
 * Compare at the precision the game can actually be observed at.
 *
 * Mine and Slash calculates in Java `float`; this engine calculates in doubles, because that
 * is what JavaScript has. The two diverge in the last bits — 80 * (1 + 0.2 * 19) is 384 in
 * float and 384.00000000000006 here — and no arrangement of the arithmetic fixes that. It
 * does not matter, because the stat sheet formats with `DecimalFormat("0.00")`, so anything
 * inside half of the last printed digit is indistinguishable in the only ground truth there
 * is. Asserting tighter than the screen can show would be testing IEEE 754, not the port.
 */
export function closeTo(actual: number | undefined, expected: number, message?: string): void {
  assert.notEqual(actual, undefined, message ?? "expected a value, got none");
  assert.ok(
    Math.abs((actual as number) - expected) <= 0.005 + 1e-9,
    message ?? `expected ${expected}, got ${actual}`,
  );
}

/** `original_balance`'s level-scaling curves, which schema's `BALANCE` leaves out. */
export const SCALING_CURVES: Record<string, unknown> = {
  NORMAL_STAT_SCALING: { base_scaling: 1, per_level_scaling: 0.2, cap_to_max_lvl: false },
  CORE_STAT_SCALING: { base_scaling: 1, per_level_scaling: 0.05, cap_to_max_lvl: true },
  SLOW_STAT_SCALING: { base_scaling: 1, per_level_scaling: 0.01, cap_to_max_lvl: true },
  STAT_REQ_SCALING: { base_scaling: 2, per_level_scaling: 2, cap_to_max_lvl: true },
  MOB_DAMAGE_SCALING: { base_scaling: 1, per_level_scaling: 0.25, cap_to_max_lvl: false },
};

export const ENGINE_BALANCE: Record<string, unknown> = {
  ...BALANCE,
  ...SCALING_CURVES,
  // `original_balance` overrides the jar default of 5. It is the denominator of every
  // spell-level interpolation, so tests that get it wrong get every `LeveledValue` wrong.
  MAX_BONUS_SPELL_LEVELS: 8,
  DMG_REDUCT_PER_CHAIN: 0.2,
  MIN_CHAIN_DMG: 0.2,
};

/** A plain `ser: "data"` stat, the shape 619 of the pack's 800 JSON stats have. */
export function statEntry(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    ser: "data",
    base: 0,
    min: -1000,
    max: 100000000,
    softcap: 0,
    has_softcap: false,
    is_perc: false,
    scaling: "NONE",
    multiUseType: "MULTIPLY_STAT",
    show_in_gui: true,
    ...extra,
  };
}

/** A `MULTIPLICATIVE_DAMAGE` stat: MORE modifiers stay out of the value. */
export function damageStat(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return statEntry(id, { multiUseType: "MULTIPLICATIVE_DAMAGE", is_perc: true, ...extra });
}

/** `one_to_other` — "gain X% of `adder` as extra `addTo`", applied after the calculation. */
export function oneToOther(
  id: string,
  adder: string,
  addTo: string,
  priority: number,
): Record<string, unknown> {
  return {
    ser: "one_to_other",
    data: { id, adder_stat: adder, add_to: addTo, priority, base: 0, min: 0, max: 100000000, perc: true, scale: "NONE" },
  };
}

/** `more_x_per_y` — "+value `addTo` per `perAmount` `adder`", applied last. */
export function moreXPerY(
  id: string,
  adder: string,
  addTo: string,
  perAmount: number,
): Record<string, unknown> {
  return {
    ser: "more_x_per_y",
    data: {
      id,
      adder_stat: adder,
      add_to: addTo,
      per_amount: perAmount,
      base: 0,
      min: 0,
      max: 100000000,
      perc: true,
      scale: "NONE",
    },
  };
}

/** `core_stat` — an attribute granting a bundle per point. */
export function coreStat(id: string, grants: Record<string, unknown>[]): Record<string, unknown> {
  return {
    ser: "core_stat",
    data: {
      id,
      base: 0,
      min: 0,
      max: 100000000,
      perc: false,
      scale: "CORE",
      core_stat_data: { stats: grants },
    },
  };
}

/** An exact modifier, as perks, base stats and gems carry them. */
export function exact(
  stat: string,
  type: string,
  v1: number,
  scaleToLvl = false,
): Record<string, unknown> {
  return { type, stat, v1, scale_to_lvl: scaleToLvl };
}

/** A rolled modifier, as affixes, gear bases and uniques carry them. */
export function rolled(stat: string, type: string, min: number, max: number): Record<string, unknown> {
  return { type, stat, min, max };
}

export function baseStats(id: string, stats: Record<string, unknown>[]): Record<string, unknown> {
  return { id, base_stats: stats };
}

// ---------------------------------------------------------------------------
// The damage pipeline
// ---------------------------------------------------------------------------

/**
 * The 14 layers exactly as `mmorpg_stat_layer` ships them.
 *
 * Written out rather than read from a real snapshot because the clamps are the point of half
 * the tests: `double_damage` pinned to `[2, 2]` and the mitigation floors at `0.1` are what
 * the pipeline's odd behaviour comes from.
 */
export const STAT_LAYERS: Record<string, Record<string, unknown>> = {
  flat_damage: layer("flat_damage", 0, "ADD", -100000000, 100000000),
  damage_conversion: layer("damage_conversion", 1, "CONVERT_PERCENT", 0, 100),
  ele_as_extra_flat: layer("ele_as_extra_flat", 2, "X_AS_BONUS_Y_ELEMENT_DAMAGE", 0, 100),
  additive_damage: layer("additive_damage", 3, "MULTIPLY", -1, 100000000),
  dot_dmg_multi: layer("dot_dmg_multi", 5, "MULTIPLY", -1, 100000000),
  crit_damage: layer("crit_damage", 7, "MULTIPLY", -1, 100000000),
  double_damage: layer("double_damage", 9, "MULTIPLY", 2, 2),
  damage_taken_as: layer("damage_taken_as", 99, "DAMAGE_TAKEN_AS", 0, 100),
  armor_mitigation: layer("armor_mitigation", 100, "MULTIPLY", 0.1, 100000000),
  physical_mitigation: layer("physical_mitigation", 101, "MULTIPLY", 0.1, 100000000),
  elemental_mitigation: layer("elemental_mitigation", 102, "MULTIPLY", 0.1, 100000000),
  damage_reduction: layer("damage_reduction", 103, "MULTIPLY", 0.5, 100000000),
  damage_suppression: layer("damage_suppression", 104, "MULTIPLY", 0.5, 1),
  // Nothing in the pack's datapack writes to this one; `DodgeRating` does, in code.
  damage_block: layer("damage_block", 105, "MULTIPLY", 0, 1),
  flat_damage_reduction: layer("flat_damage_reduction", 200, "ADD", -1000, 100000000),
};

export function layer(
  id: string,
  priority: number,
  action: string,
  minMulti: number,
  maxMulti: number,
): Record<string, unknown> {
  return { id, name: id, priority, action, min_multi: minMulti, max_multi: maxMulti };
}

/** One `effect` block, as the 619 datapack stats carry them. */
export function effectBlock(
  order: string,
  effects: string[],
  ifs: string[] = [],
  side: "Source" | "Target" = "Source",
  events: string[] = ["on_damage"],
): Record<string, unknown> {
  return { order, side, ifs, effects, events };
}

/** A `modify_stat_layer` effect — the workhorse of the damage layers. */
export function modifyLayer(
  id: string,
  layerId: string,
  modification: "ADD" | "REDUCE" = "ADD",
  provider: Record<string, unknown> = { type: "STAT_DATA", calc: "" },
  modifiers: string[] = [],
): Record<string, unknown> {
  return {
    id,
    ser: "modify_stat_layer",
    layer: layerId,
    modification,
    number_to_modify: "number",
    number_provider: provider,
    number_modifiers: modifiers.map((type) => ({ type })),
  };
}

export function condition(id: string, ser: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, ser, ...extra };
}

/** A `mmorpg_value_calc` entry. */
export function valueCalcEntry(
  id: string,
  base: { min: number; max: number },
  scalings: { stat: string; min: number; max: number }[] = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    base,
    base_scaling_type: "NORMAL",
    cap_to_wep_dmg: 1000,
    dmg_effectiveness: { stat: "health", multi: { min: 1, max: 1 } },
    stat_scalings: scalings.map((s) => ({ stat: s.stat, multi: { min: s.min, max: s.max } })),
    target_stat_scalings: [],
    ...extra,
  };
}

/** A minimal spell with a single `damage` action. */
export function spellEntry(
  id: string,
  element: string,
  valueCalcId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    identifier: id,
    min_lvl: 1,
    max_lvl: 16,
    default_lvl: 1,
    lvl_based_on_spell: "",
    statsForSkillGem: [],
    config: { tags: { tags: [] }, use_support_gems_from: "" },
    attached: {
      on_cast: [
        {
          acts: [{ type: "damage", map: { element, value_calculation: valueCalcId } }],
          ifs: [],
          // Every one of the pack's 425 `damage` acts carries a target selector, and a part
          // with none selects nothing at all — `ComponentPart.tryActivate` hands
          // `DamageAction` an empty collection. A fixture without one is not a simpler spell,
          // it is a spell that deals no damage.
          targets: [{ type: "aoe", map: { radius: 3, selection_type: "RADIUS", en_predicate: "enemies" } }],
          en_preds: [],
        },
      ],
      entity_components: {},
    },
    ...extra,
  };
}

/**
 * A snapshot with the balance file and whatever registries a test needs. Every category is
 * merged over the defaults, so a test only writes the part it is about.
 */
export function engineSnapshot(registries: Registries = {}): Snapshot {
  const base: Registries = {
    mmorpg_game_balance: { original_balance: ENGINE_BALANCE },
    mmorpg_base_stats: { original_mode_player: baseStats("original_mode_player", []) },
    mmorpg_stat_layer: STAT_LAYERS,
  };
  const merged: Registries = { ...base };
  for (const [category, entries] of Object.entries(registries)) {
    merged[category] = { ...(base[category] ?? {}), ...entries };
  }
  return makeSnapshot(merged);
}
