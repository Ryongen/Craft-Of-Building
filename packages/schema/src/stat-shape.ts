/**
 * The fields of `Stat` the calculation reads, independent of where a stat came from.
 *
 * A stat reaches the engine by one of two routes — a JSON entry in `mmorpg_stat`, or the
 * generated table of the ones registered only in Java — and the container must not care
 * which. Both are normalised into a `StatShape`.
 *
 * Defaults are `Stat`'s own field initialisers (Stat.java:66-80), which is what a stat has
 * before its constructor or its JSON touches anything. Applying them explicitly matters: the
 * five non-`data` serializers nest their payload under `data` and carry no `min`, `max` or
 * `multiUseType` at all, so a missing field is normal rather than suspicious.
 */

/** `STATICS.MAX_FLOAT`. Also `Stat.max`'s default, and what the GUI renders as "Inf". */
export const MAX_FLOAT = 100_000_000;

/**
 * `StatScaling` (StatScaling.java). Each bucket multiplies by a `LevelScalingConfig` out of
 * `mmorpg_game_balance`; `NONE` returns the value untouched.
 */
export const STAT_SCALINGS = ["NONE", "NORMAL", "CORE", "STAT_REQ", "MOB_DAMAGE", "SLOW"] as const;
export type StatScaling = (typeof STAT_SCALINGS)[number];

export function isStatScaling(value: string): value is StatScaling {
  return (STAT_SCALINGS as readonly string[]).includes(value);
}

/**
 * `Stat.MultiUseType`. The whole reason `ComputedStat` has two numbers.
 *
 * `MULTIPLY_STAT` folds accumulated MORE modifiers into the value. `MULTIPLICATIVE_DAMAGE`
 * does not — it carries them out of band in `StatData.m` for the damage layer to apply, and
 * `StatData.getValue()` returns the value without them.
 */
export const MULTI_USE_TYPES = ["MULTIPLY_STAT", "MULTIPLICATIVE_DAMAGE"] as const;
export type MultiUseType = (typeof MULTI_USE_TYPES)[number];

export function isMultiUseType(value: string): value is MultiUseType {
  return (MULTI_USE_TYPES as readonly string[]).includes(value);
}

export type StatShape = {
  base: number;
  min: number;
  /** `Stat.getHardCap()`. */
  max: number;
  softcap: number;
  /**
   * Nothing in the mod calls `setSoftCap` and no JSON stat sets `has_softcap`, so this is
   * false for all 1,153 stats as shipped and `Stat.getCap()` always returns the hard cap.
   * Modelled anyway because the GUI has a row for it and a mod update could fill it in.
   */
  hasSoftcap: boolean;
  isPerc: boolean;
  scaling: StatScaling;
  multiUseType: MultiUseType;
};

export const STAT_DEFAULTS: StatShape = {
  base: 0,
  min: -1000,
  max: MAX_FLOAT,
  softcap: 0,
  hasSoftcap: false,
  isPerc: false,
  scaling: "NONE",
  multiUseType: "MULTIPLY_STAT",
};
