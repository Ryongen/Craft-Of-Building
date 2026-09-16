/**
 * The stat container for Craft to Exile 2.
 *
 * Give it a build document and an extractor snapshot, get back what the game's character
 * sheet would show. `calculateStats` is the narrow form the fixture runner consumes;
 * `calculate` is the same work with the contributions and diagnostics kept.
 */

import type { Snapshot } from "@cte2/extractor";
import type { BuildDoc, ComputedStat, StatCalculator } from "@cte2/schema";

import { calculate, type EngineOptions } from "./calculate.js";

export { calculate, resolveEffects } from "./calculate.js";
export type {
  DerivedContribution,
  EngineOptions,
  EngineResult,
  EngineStat,
} from "./calculate.js";

export { balance } from "./balance.js";
export type { Balance, LevelScaling } from "./balance.js";

export { DEFAULT_STAT_REQ_MULTI, checkRequirements, gearRequirements } from "./requirements.js";
export type { GearRequirement, RequirementCheck, RequirementOptions } from "./requirements.js";

export { statIndex, STAT_CATEGORY } from "./stat-def.js";
export type { EffectBlock, StatBehaviour, StatDef, StatIndex, StatSer } from "./stat-def.js";

export {
  MAX_FLOAT,
  MULTI_USE_TYPES,
  STAT_DEFAULTS,
  STAT_SCALINGS,
  isMultiUseType,
  isStatScaling,
} from "./stat-shape.js";
export type { MultiUseType, StatScaling, StatShape } from "./stat-shape.js";

export {
  MOD_TYPES,
  isKnownModType,
  levelScale,
  modTypeFromString,
  multiplyExact,
  parseRolledMod,
  parseRolledMods,
  parseSourceMod,
  parseSourceMods,
  rollToExact,
  sourceToExact,
} from "./modifier.js";
export type { ExactMod, ModOrigin, ModType, RolledMod, SourceMod } from "./modifier.js";

export { InCalcContainer, InCalcStat, StatContainer, clamp } from "./container.js";
export type { StatValue } from "./container.js";

export { CTX_TYPES, context, makeEnv } from "./context.js";
export type { CtxType, Env, StatContext } from "./context.js";

export { CODE_ONLY_STATS, CODE_ONLY_TRANSFERS } from "./code-only-stats.generated.js";
export {
  CTX_MODIFIERS,
  CTX_MODIFIER_STATS,
  RESIST_BASE_CAP,
  RESIST_HARD_CAP,
  USABLE_STATS,
} from "./code-only-behaviour.js";
export type { UsableStat } from "./code-only-behaviour.js";

export { LITE_MODE, ORIGINAL_MODE } from "./compat.js";
export type { Compat } from "./compat.js";

// --- the damage pipeline (phase 2) ---------------------------------------------------

export { simulateBasicAttack, simulateHit } from "./damage/simulate.js";
export type { DamageOptions, DamageResult, HitOutcome } from "./damage/simulate.js";

export {
  ATTACK_SPEED_ATTRIBUTE,
  baseAttackSpeedFrom,
  basicAttack,
  swingsPerSecond,
} from "./damage/basic-attack.js";
export type { BasicAttack, BasicAttackOptions } from "./damage/basic-attack.js";

// --- the rate (phase 3) ---------------------------------------------------------------

export { damageWithin, simulateDps, simulateFullDps, timeToKill } from "./damage/dps.js";
export type {
  DpsOptions,
  DpsResult,
  FullDpsResult,
  FullDpsRole,
  FullDpsSkill,
  MultiHitInfo,
  Overlap,
  ResourceCost,
  SelfDamage,
  SourceResult,
} from "./damage/dps.js";

// --- what a cast produces, and how much of it lands (phase 4) --------------------------

export {
  carrierSeconds,
  declaresDamage,
  originLabel,
  potionConditionKey,
  skillModel,
  sourceLabel,
} from "./damage/skill-model.js";
export type {
  Carrier,
  DamageSource,
  Origin,
  ProjectileMotion,
  SkillModel,
  SourceRequirement,
  SourceTarget,
  SpawnFrom,
  SpawnStep,
  Trigger,
} from "./damage/skill-model.js";

export {
  NO_EFFECTS,
  activeOn,
  atMaxStacks,
  casterBuffUpkeep,
  hasEffect,
  resolveEffectState,
  supportGemAffectsSheet,
} from "./damage/effect-state.js";
export { procDps, resolveProcs, rotationProcs } from "./damage/procs.js";
export type { Proc, ProcLimit, RotationPresses } from "./damage/procs.js";
export { resolveSummons, summonDps } from "./damage/summons.js";
export type { SummonOutput, SummonSpellCast } from "./damage/summons.js";
export type {
  BuffUpkeep,
  EffectGrant,
  EffectHolder,
  EffectOption,
  EffectState,
} from "./damage/effect-state.js";

export { DEFAULT_PLACEMENT, coverageOf } from "./damage/geometry.js";
export type { Coverage, CoverageMethod, TargetPlacement } from "./damage/geometry.js";

export { TICKS_PER_SECOND, calculateSpell, rateOf, spellConfig } from "./damage/spell-calc.js";
export type { CastRate, SpellCalc, SpellCalcInput, SpellConfig } from "./damage/spell-calc.js";

export { Recorder, traceTotal } from "./damage/breakdown.js";
export type {
  EventTrace,
  LayerContribution,
  LayerStep,
  MoreStep,
  WriteKind,
} from "./damage/breakdown.js";

export { AILMENTS } from "./damage/ailments.js";
export type { Ailment, AilmentResult } from "./damage/ailments.js";

export { LAYER, LAYER_ACTIONS, LayerData, isLayerAction, layerIndex } from "./damage/layers.js";
export type { LayerAction, LayerIndex, StatLayer } from "./damage/layers.js";

export { DATAPACK_PRIORITY, PRIORITY, datapackPriority } from "./damage/priority.js";

export { DamageEventState, EVENT, EventData } from "./damage/event.js";
export type { AttackType, BonusElement, EffectSide, MoreMulti } from "./damage/event.js";

export { MAX_CONVERSION_DEPTH, inCodeEffects } from "./damage/code-only-effects.js";
export type { InCodeEffect } from "./damage/code-only-effects.js";

export {
  baseValue,
  calculatedValue,
  damageEffectiveness,
  leveledValue,
  valueCalc,
} from "./damage/value-calc.js";
export type { LeveledValue, ScalingCalc, StatReader, ValueCalc } from "./damage/value-calc.js";

export { resolveCombo } from "./damage/combo.js";
export {
  LEECH_BANK_SECONDS,
  IN_COMBAT_REGEN_MULTI_KEY,
  PACK_IN_COMBAT_REGEN_MULTI,
  inCombatRegenMultiOf,
  RESOURCES,
  budget,
  leech,
  resourceSpent,
  resources,
} from "./damage/resources.js";
export type {
  BudgetInput,
  Leech,
  LeechEntry,
  LeechInput,
  LeechSource,
  Regen,
  ResourceBudget,
  ResourceId,
  ResourceOptions,
  Resources,
  UnratedLeech,
} from "./damage/resources.js";

export { defence } from "./damage/defence.js";
export type { Defence, DefenceOptions, ElementDefence, Pools } from "./damage/defence.js";

export type { BrokenLink, ComboChain, ComboStep } from "./damage/combo.js";

export { evaluateCondition, evaluateIfs } from "./damage/conditions.js";
export type { Outcome, StatSubject } from "./damage/conditions.js";

export { applyStatEffect } from "./damage/effects.js";
export type { EffectSubject } from "./damage/effects.js";

export type { DamageCtx, ProcHit, RestoreRecord, Sheet } from "./damage/ctx.js";

// The collectors, so an editor can preview one item or one perk through the exact code path
// the sheet uses rather than a parallel reimplementation that can drift from it.
export { collectBaseStats } from "./collect/base-stats.js";
export { collectAuras, collectExileEffects } from "./collect/effects.js";
export { collectGear, collectJewels } from "./collect/gear.js";
export { collectOmen } from "./collect/omen.js";
export { collectPerks } from "./collect/perks.js";
export { collectStatPoints } from "./collect/stat-points.js";
export { collectSpellContexts, maxSpellLevel, spellLevel, spellRanks } from "./collect/spell.js";
export type { SpellRanks } from "./collect/spell.js";

/**
 * The engine as `@cte2/schema` declares it.
 *
 * Diagnostics are dropped on this path — the fixture runner reports the build's legality
 * separately, and a caller who wants to know what the engine was unsure about should use
 * {@link calculate}.
 */
export const calculateStats: StatCalculator = (build: BuildDoc, snapshot: Snapshot) => {
  return toComputed(calculate(build, snapshot));
};

/** {@link calculateStats} with the balance and base-stat entries chosen explicitly. */
export function statCalculatorWith(options: EngineOptions): StatCalculator {
  return (build, snapshot) => toComputed(calculate(build, snapshot, options));
}

function toComputed(result: ReturnType<typeof calculate>): Map<string, ComputedStat> {
  const out = new Map<string, ComputedStat>();
  for (const [id, stat] of result.stats) {
    out.set(id, {
      value: stat.value,
      dmgMulti: stat.dmgMulti,
      softcap: stat.softcap,
      hardcap: stat.hardcap,
      ...(stat.usableValue === undefined ? {} : { usableValue: stat.usableValue }),
    });
  }
  return out;
}
