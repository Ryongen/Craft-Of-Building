/**
 * `mmorpg_value_calc` — a spell's base damage, before the damage event touches it.
 *
 * This is the number the spell tooltip prints, which makes it the cheapest thing in phase 2 to
 * check against the game: no capture tooling, just read the tooltip
 * (`ValueCalculation.getShortTooltip`, ValueCalculation.java:120-160).
 *
 * Two different level scalings meet here and conflating them is the easy mistake:
 *
 *   - **spell level** drives `LeveledValue`, a plain interpolation with no curve behind it;
 *   - **character level** drives `StatScaling`, which is the `mmorpg_game_balance` curve
 *     `Balance.multiFor` already implements.
 *
 * A third thing that looks like it belongs and does not: `dmg_effectiveness`. It is a
 * `ScalingCalc` field on the same object, but `getAllScalingValues()` returns
 * `stat_scalings` alone (ValueCalculation.java:32-34), so effectiveness never enters the
 * value. It is handed to the event separately as `EventData.DMG_EFFECTIVENESS` and multiplies
 * *flat damage adds* later — see `NumberModifier.SPELL_DAMAGE_EFFECTIVENESS_MULTI`.
 */

import type { Snapshot } from "@cte2/extractor";
import { CATEGORY, entry } from "@cte2/schema";

import type { Balance } from "../balance.js";
import type { Compat } from "../compat.js";
import { isStatScaling, type StatScaling } from "@cte2/schema";

/** `LeveledValue` — a `{min, max}` band read at a spell level. */
export type LeveledValue = { min: number; max: number };

/** `ScalingCalc` — "this much of that stat". */
export type ScalingCalc = { statId: string; multi: LeveledValue };

export type ValueCalc = {
  id: string;
  base: LeveledValue;
  baseScaling: StatScaling;
  /** Read against the caster. */
  statScalings: ScalingCalc[];
  /** Read against the target, and only when there is one. */
  targetStatScalings: ScalingCalc[];
  dmgEffectiveness: ScalingCalc;
  capToWeaponDamage: number;
};

/** The stat lookup the calc needs: the **base** unit's sheet, never the spell unit. */
export type StatReader = (statId: string) => number;

/**
 * `LeveledValue.getValue` (LeveledValue.java:14-27).
 *
 *     if (min == max) return min;
 *     int maxlevel = provider.getMaxLevelWithBonuses();
 *     int level = provider.getCurrentLevel(en);
 *     float perlevel = (max - min) / maxlevel;
 *     return min + (perlevel * level);
 *
 * Note it is not a lerp to `max` at `maxLevel` — the denominator is
 * `max_lvl + MAX_BONUS_SPELL_LEVELS`, so a spell at its own `max_lvl` reads well short of
 * `max`. With `original_balance`'s bonus of 8, a 16-level spell tops out at 16/24 of the band.
 */
export function leveledValue(value: LeveledValue, level: number, maxLevel: number): number {
  if (value.min === value.max) return value.min;
  if (maxLevel <= 0) return value.min;
  return value.min + ((value.max - value.min) / maxLevel) * level;
}

export function valueCalc(snapshot: Snapshot, id: string): ValueCalc | undefined {
  const data = entry(snapshot, CATEGORY.valueCalc, id)?.data;
  if (!data) return undefined;

  const scale = data["base_scaling_type"];
  return {
    id,
    base: leveledOf(data["base"]),
    baseScaling: typeof scale === "string" && isStatScaling(scale) ? scale : "NORMAL",
    statScalings: scalingsOf(data["stat_scalings"]),
    targetStatScalings: scalingsOf(data["target_stat_scalings"]),
    dmgEffectiveness: scalingOf(data["dmg_effectiveness"]) ?? {
      statId: "health",
      multi: { min: 1, max: 1 },
    },
    capToWeaponDamage: numberAt(data, "cap_to_wep_dmg") ?? 1000,
  };
}

/**
 * `getCalculatedValue` (ValueCalculation.java:108-119) — scaling plus base.
 *
 * The truncations are load-bearing and there are three layers of them: every `ScalingCalc`
 * returns an `int`, the non-weapon terms are summed through `mapToInt`, and both halves are
 * cast again on the way out. Rounding instead of truncating drifts by a few points on a big
 * hit, which is exactly the size of error a capture would struggle to attribute.
 */
export function calculatedValue(
  calc: ValueCalc,
  caster: StatReader,
  target: StatReader | null,
  spellLevel: number,
  maxSpellLevel: number,
  characterLevel: number,
  bal: Balance,
  compat: Compat,
): number {
  const at = (v: LeveledValue): number => leveledValue(v, spellLevel, maxSpellLevel);

  // `WeaponDamage` is pulled out first and only the *first* match counts — `findFirst()`.
  const weapon = calc.statScalings.find((s) => s.statId === WEAPON_DAMAGE);
  const dmg = weapon ? Math.trunc(at(weapon.multi) * caster(weapon.statId)) : 0;

  let other = 0;
  for (const scaling of calc.statScalings) {
    if (scaling.statId === WEAPON_DAMAGE) continue;
    other += Math.trunc(at(scaling.multi) * caster(scaling.statId));
  }
  if (target) {
    for (const scaling of calc.targetStatScalings) {
      if (scaling.statId === WEAPON_DAMAGE) continue;
      other += Math.trunc(at(scaling.multi) * target(scaling.statId));
    }
  }

  // `capsToWeaponDamage()` is `cap_to_wep_dmg < 50` — so the default of 1000 means *no* cap,
  // and the 26 entries at 2 and 5 at 10 are the ones that actually bind.
  if (calc.capToWeaponDamage < 50) {
    const ceiling = dmg * calc.capToWeaponDamage;
    if (other > ceiling) other = ceiling;
  }

  return Math.trunc(other + dmg) + baseValue(calc, spellLevel, maxSpellLevel, characterLevel, bal, compat);
}

/**
 * `getCalculatedBaseValue` (ValueCalculation.java:51-62).
 *
 *     float basedmg = base_scaling_type.scale(base.getValue(en, provider), Load.Unit(en).getLevel());
 *     basedmg *= CompatConfig.get().spellBaseDmgMulti();
 *     return (int) basedmg;
 */
export function baseValue(
  calc: ValueCalc,
  spellLevel: number,
  maxSpellLevel: number,
  characterLevel: number,
  bal: Balance,
  compat: Compat,
): number {
  const raw = leveledValue(calc.base, spellLevel, maxSpellLevel);
  return Math.trunc(raw * bal.multiFor(calc.baseScaling, characterLevel) * compat.spellBaseDamageMulti);
}

/**
 * `getDamageEffectiveness` (ValueCalculation.java:64-66) — just the multi, read at the spell's
 * level. The `stat` half of that `ScalingCalc` is never consulted; it is `health` on all 253
 * entries and reading it would be wrong anyway.
 */
export function damageEffectiveness(calc: ValueCalc, spellLevel: number, maxSpellLevel: number): number {
  return leveledValue(calc.dmgEffectiveness.multi, spellLevel, maxSpellLevel);
}

const WEAPON_DAMAGE = "weapon_damage";

function scalingsOf(raw: unknown): ScalingCalc[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(scalingOf).filter((s): s is ScalingCalc => s !== undefined);
}

function scalingOf(raw: unknown): ScalingCalc | undefined {
  const node = asObject(raw);
  if (!node) return undefined;
  const statId = node["stat"];
  if (typeof statId !== "string" || statId.length === 0) return undefined;
  return { statId, multi: leveledOf(node["multi"]) };
}

function leveledOf(raw: unknown): LeveledValue {
  const node = asObject(raw);
  if (!node) return { min: 0, max: 0 };
  return { min: numberAt(node, "min") ?? 0, max: numberAt(node, "max") ?? 0 };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberAt(node: Record<string, unknown>, key: string): number | undefined {
  const v = node[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
