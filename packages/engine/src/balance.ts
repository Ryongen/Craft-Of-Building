/**
 * `mmorpg_game_balance`, as far as the stat container needs it.
 *
 * Only the level-scaling curves and `MAX_LEVEL` matter here; the rest of that registry is
 * drop rates, backpack sizes and mob scaling. Craft to Exile 2 runs `original_balance`, which
 * `@cte2/schema` already knows as `DEFAULT_BALANCE_ID`.
 */

import type { Snapshot } from "@cte2/extractor";
import { CATEGORY, DEFAULT_BALANCE_ID, entry } from "@cte2/schema";

import type { StatScaling } from "@cte2/schema";

/** `LevelScalingConfig`. */
export type LevelScaling = {
  baseScaling: number;
  perLevelScaling: number;
  capToMaxLvl: boolean;
};

export type Balance = {
  id: string;
  maxLevel: number;
  /**
   * `GameBalanceConfig.MAX_BONUS_SPELL_LEVELS`, the headroom above a spell's own `max_lvl`
   * that `Spell.getMaxLevelWithBonuses()` adds. It is the denominator of every spell-level
   * interpolation, so it is not cosmetic: the jar default is 5 but `original_balance` — the
   * entry this pack actually runs — sets **8**, which moves every `LeveledValue` in the game.
   */
  maxBonusSpellLevels: number;
  /** `GameBalanceConfig.DMG_REDUCT_PER_CHAIN`, applied per chain jump already made. */
  damageReductionPerChain: number;
  /** `GameBalanceConfig.MIN_CHAIN_DMG`, the floor that reduction clamps to. */
  minChainDamage: number;
  /**
   * `GameBalanceConfig.MIN_SPELL_COOLDOWN_MULTI` — the floor cooldown reduction clamps to, as a
   * fraction of the spell's declared cooldown. 0.2 means "at most 80% off".
   */
  minSpellCooldownMulti: number;
  /**
   * `GameBalanceConfig.GLOBAL_COOLDOWN_TICKS`. Casting anything puts a shared cooldown on
   * everything, itself capped at the spell's own cooldown so rapid-fire spells stay rapid
   * (`SpellCastingData.java:275`).
   */
  globalCooldownTicks: number;
  /**
   * `GameBalanceConfig.CHANNEL_GENERAL_SPEED_TRANSFER` — how much of a `channel` spell's general
   * cast speed carries over before `channel_speed_perc` is added on top
   * (`SpellStatsCalculationEvent.activate`, 6.4.13). `original_balance` sets 1, so channelled
   * spells get their cast speed in full *and* their channel speed.
   */
  channelSpeedTransfer: number;
  /** `GameBalanceConfig.MANA_COST_SCALING`, which scales a spell's mana and energy cost by level. */
  manaCostScaling: LevelScaling;
  /**
   * The multiplier a `FLAT` modifier of this scaling gets at this level.
   *
   *     public float getMultiFor(float lvl) {
   *         if (cap_to_max_lvl) { lvl = Mth.clamp(lvl, 1, GameBalanceConfig.get().MAX_LEVEL); }
   *         return base_scaling + (per_level_scaling * (lvl - 1));
   *     }
   *
   * — LevelScalingConfig.java:21-27. Note the cap applies to the *level*, not the result, so
   * an uncapped curve (`NORMAL` in original mode) keeps climbing past 100.
   */
  multiFor(scaling: StatScaling, level: number): number;
};

/** Which `LevelScalingConfig` each `StatScaling` reads (StatScaling.java:5-43). */
const CONFIG_KEY: Record<StatScaling, string | null> = {
  NONE: null,
  NORMAL: "NORMAL_STAT_SCALING",
  CORE: "CORE_STAT_SCALING",
  STAT_REQ: "STAT_REQ_SCALING",
  MOB_DAMAGE: "MOB_DAMAGE_SCALING",
  SLOW: "SLOW_STAT_SCALING",
};

/**
 * `GameBalanceConfig`'s own field initialisers, used when the registry entry omits a curve.
 * These are the jar defaults, not the pack's — the pack overrides `original_balance` wholesale
 * and every curve is present there, so this is a floor rather than something load-bearing.
 */
const FALLBACK: Record<string, LevelScaling> = {
  NORMAL_STAT_SCALING: { baseScaling: 1, perLevelScaling: 0.2, capToMaxLvl: false },
  CORE_STAT_SCALING: { baseScaling: 1, perLevelScaling: 0.05, capToMaxLvl: true },
  SLOW_STAT_SCALING: { baseScaling: 1, perLevelScaling: 0.01, capToMaxLvl: true },
  STAT_REQ_SCALING: { baseScaling: 2, perLevelScaling: 0.2, capToMaxLvl: true },
  MOB_DAMAGE_SCALING: { baseScaling: 1, perLevelScaling: 0.025, capToMaxLvl: false },
};

/** `GameBalanceConfig.MANA_COST_SCALING`, which is not a `StatScaling` and so is not in `CONFIG_KEY`. */
const MANA_COST_FALLBACK: LevelScaling = { baseScaling: 1, perLevelScaling: 0.2, capToMaxLvl: true };

/**
 * Cached per snapshot and balance id. A `Balance` closes over its curves and never mutates,
 * so sharing one is safe — and `multiFor` is called once per FLAT modifier, which for a geared
 * character is thousands of times per calculation.
 */
const BALANCE_CACHE = new WeakMap<Snapshot, Map<string, Balance>>();

export function balance(snapshot: Snapshot, balanceId: string = DEFAULT_BALANCE_ID): Balance {
  let byId = BALANCE_CACHE.get(snapshot);
  if (!byId) {
    byId = new Map();
    BALANCE_CACHE.set(snapshot, byId);
  }
  const cached = byId.get(balanceId);
  if (cached) return cached;

  const built = buildBalance(snapshot, balanceId);
  byId.set(balanceId, built);
  return built;
}

function buildBalance(snapshot: Snapshot, balanceId: string): Balance {
  const data = entry(snapshot, CATEGORY.gameBalance, balanceId)?.data ?? {};
  const maxLevel = numberAt(data, "MAX_LEVEL") ?? 100;

  const curves = new Map<string, LevelScaling>();
  for (const key of Object.keys(FALLBACK)) {
    curves.set(key, readCurve(data[key]) ?? FALLBACK[key]!);
  }

  return {
    id: balanceId,
    maxLevel,
    maxBonusSpellLevels: numberAt(data, "MAX_BONUS_SPELL_LEVELS") ?? 5,
    damageReductionPerChain: numberAt(data, "DMG_REDUCT_PER_CHAIN") ?? 0.2,
    minChainDamage: numberAt(data, "MIN_CHAIN_DMG") ?? 0.2,
    minSpellCooldownMulti: numberAt(data, "MIN_SPELL_COOLDOWN_MULTI") ?? 0.2,
    globalCooldownTicks: numberAt(data, "GLOBAL_COOLDOWN_TICKS") ?? 3,
    channelSpeedTransfer: numberAt(data, "CHANNEL_GENERAL_SPEED_TRANSFER") ?? 1,
    manaCostScaling: readCurve(data["MANA_COST_SCALING"]) ?? MANA_COST_FALLBACK,
    multiFor(scaling, level) {
      const key = CONFIG_KEY[scaling];
      if (key === null) return 1;
      const curve = curves.get(key)!;
      const lvl = curve.capToMaxLvl ? Math.min(Math.max(level, 1), maxLevel) : level;
      return curve.baseScaling + curve.perLevelScaling * (lvl - 1);
    },
  };
}

function readCurve(node: unknown): LevelScaling | undefined {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
  const n = node as Record<string, unknown>;
  const baseScaling = numberAt(n, "base_scaling");
  const perLevelScaling = numberAt(n, "per_level_scaling");
  if (baseScaling === undefined || perLevelScaling === undefined) return undefined;
  return {
    baseScaling,
    perLevelScaling,
    capToMaxLvl: typeof n["cap_to_max_lvl"] === "boolean" ? n["cap_to_max_lvl"] : true,
  };
}

function numberAt(node: Record<string, unknown>, key: string): number | undefined {
  const v = node[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
