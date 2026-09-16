/**
 * `CompatConfig` — the handful of Forge-config numbers that reach the damage math.
 *
 * These are **not** in any registry, so the extractor cannot see them. They come from
 * `CompatConfigPreset.ORIGINAL_MODE.defaults`, which is what `CompatConfig.get()` returns
 * whenever the compatibility addon is absent:
 *
 *     public static CompatDummy get() {
 *         if (!IRestrictedConfig.compatModeIsInstalled()) {
 *             return CompatConfigPreset.ORIGINAL_MODE.defaults;
 *         }
 *         ...
 *     }
 *
 * — CompatConfig.java:12-19. Craft to Exile 2 does not ship the addon (`@cte2/schema` pins the
 * same conclusion from the other direction: the pack overrides `original_balance` and
 * `original_mode_player` and leaves every `compat_mode_*` entry at jar defaults), so these
 * values are what the game runs.
 *
 * Two of them are 1 or 100 and therefore invisible in the arithmetic. They are written out
 * anyway, because a term that happens to be an identity is not the same as a term that is not
 * there — a server running LITE_MODE would double every spell's base damage, and an engine
 * that had quietly dropped the multiplier could not even express that.
 */

export type Compat = {
  /** `spellBaseDmgMulti()` — multiplies `ValueCalculation`'s base term. */
  spellBaseDamageMulti: number;
  /**
   * `dmgConvertLoss`, a percentage. 100 in original mode, meaning converted damage keeps
   * 100% of its value — the "loss" is what is *retained*, not what is shed.
   */
  damageConvertLoss: number;
  /** `mobFlatBonusDamage`, added to a mob's weapon-damage scaling term. */
  mobFlatBonusDamage: number;
  /** `mobPercBonusDmg`. */
  mobPercentBonusDamage: number;
};

/** `CompatConfigPreset.ORIGINAL_MODE` (CompatConfigPreset.java:25-45). */
export const ORIGINAL_MODE: Compat = {
  spellBaseDamageMulti: 1,
  damageConvertLoss: 100,
  mobFlatBonusDamage: 6,
  mobPercentBonusDamage: 0.33,
};

/**
 * `CompatConfigPreset.LITE_MODE` (CompatConfigPreset.java:7-24). Unreachable in this pack;
 * present so the difference is stated rather than implied.
 */
export const LITE_MODE: Compat = {
  spellBaseDamageMulti: 2,
  damageConvertLoss: 0,
  mobFlatBonusDamage: 0,
  mobPercentBonusDamage: 0.33,
};
