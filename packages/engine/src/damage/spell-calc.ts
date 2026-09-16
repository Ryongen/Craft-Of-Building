/**
 * `on_spell_stat_calc` — how fast a spell actually goes off, and what it costs.
 *
 * The game runs a whole second stat event to decide this: `SpellStatsCalculationEvent` seeds
 * the spell's declared numbers, sweeps the caster's stats over them, then clamps. It is the
 * same machinery as the damage event over a different set of numbers, which is why almost
 * everything here is reused rather than rewritten — `evaluateIfs`, `applyStatEffect` and the
 * `spell_has_tag_*` conditions all work unchanged.
 *
 * ## The rate, as 6.4.13 computes it
 *
 * This is the part that changed most between the reference checkout (6.4.8) and the jar this
 * pack runs (6.4.13), and the change is not cosmetic — it decides the denominator of every DPS
 * figure. 6.4.13 added `cast_speed_ticks` to `SpellConfiguration` and made it, not
 * `cooldown_ticks`, the number that governs how often most spells go off:
 *
 *   - `SpellStatsCalculationEvent` seeds `CAST_SPEED_TICKS`, `CAST_SPEED_PERCENT` and
 *     `CHANNEL_SPEED_PERCENT` alongside the numbers 6.4.8 already had. All 40 of the pack's
 *     `*_cast_time` stats plus `skill_speed` write `cast_speed_perc`;
 *   - `activate()` turns that percentage into `speedMulti = 1 + max(-99, percent) / 100`, then
 *     sets `CAST_SPEED_TICKS = max(GLOBAL_COOLDOWN_TICKS, cast_speed_ticks / speedMulti)` and
 *     divides `CAST_TICKS` by the same multiplier. A `channel` spell folds
 *     `channel_speed_perc` in first, weighted by `CHANNEL_GENERAL_SPEED_TRANSFER`;
 *   - `Spell.getEffectiveCooldownTicks` is `max(getCooldownTicks, getCastSpeedTicks)`, so a
 *     spell's own cooldown can never be shorter than its cast speed;
 *   - `SpellCastingData.armGlobalCooldown` puts `getCastSpeedTicks` on the **shared**
 *     `GLOBAL_COOLDOWN` key on every cast, unless `cast_speed_ticks <= 0`
 *     (`SpellConfiguration.isOffGlobalCooldown`). That shared arm is what makes a rotation cost
 *     real time, and it is what `fullDps` divides by.
 *
 * Without this, a spell like `raging_dragon` — which declares `cast_time_ticks: 0` and
 * `cooldown_ticks: 0` and carries all of its rate in `cast_speed_ticks: 15` — resolves to a
 * one-tick cycle and reports a DPS twenty times too large.
 *
 * `times_to_cast` still fires that many times *during* the cast (`Spell.onCastingTick`,
 * Spell.java:169-183) rather than as a burst afterwards.
 *
 * ## The rate is portable; the target count is not
 *
 * What the mod does not answer is how many times one *target* is hit by a spell that fires
 * nine projectiles in a nova. That is geometry — see `geometry.ts`, which integrates the
 * projectile's own flight from the same fields the game reads, and `skill-model.ts`, which
 * decides which damage sources a cast produces in the first place.
 */

import type { Snapshot } from "@cte2/extractor";
import type { BuildConfig, Diagnostic, SkillSetup } from "@cte2/schema";
import { CATEGORY, entry, supportLinks } from "@cte2/schema";

import type { Balance } from "../balance.js";
import type { Compat } from "../compat.js";
import type { StatIndex } from "../stat-def.js";
import { supportSocketsFor } from "../collect/spell.js";
import { evaluateIfs } from "./conditions.js";
import { applyStatEffect } from "./effects.js";
import type { DamageCtx, Sheet } from "./ctx.js";
import { DamageEventState, EVENT } from "./event.js";
import { UNKNOWN_ORDER_PRIORITY, datapackPriority } from "./priority.js";
import type { EffectState } from "./effect-state.js";
import type { LayerIndex } from "./layers.js";

/** `SpellStatsCalculationEvent.ID`. */
const ON_SPELL_STAT_CALC = "on_spell_stat_calc";

/** Minecraft's tick rate. Every duration in a spell config is in ticks. */
export const TICKS_PER_SECOND = 20;

/**
 * `SpellConfiguration.DEFAULT_PROC_COOLDOWN_TICKS`.
 *
 * 429 of the pack's 432 spells declare a `proc_cooldown_ticks` of their own; this is what the
 * other three get. It is the only thing limiting how often a spell that cannot be cast happens.
 */
export const DEFAULT_PROC_COOLDOWN_TICKS = 20;

/** What a spell declares before any stat touches it — `SpellConfiguration`. */
export type SpellConfig = {
  castTimeTicks: number;
  /**
   * `cast_speed_ticks` — 6.4.13's global-cooldown arm. Absent in 6.4.8, so an older snapshot
   * reads 0, which `isOffGlobalCooldown` treats as "not on the global cooldown" and leaves the
   * old `cast_ticks + cd_ticks` cycle intact.
   */
  castSpeedTicks: number;
  /** `proc_cooldown_ticks` — how often this spell may be re-triggered as a proc. Reported, not applied. */
  procCooldownTicks: number;
  cooldownTicks: number;
  chargeRegenTicks: number;
  charges: number;
  timesToCast: number;
  manaCost: number;
  energyCost: number;
  tags: string[];
  /**
   * `SpellConfiguration.channel_skill`, which is **not** the `channel` tag.
   *
   * The two exist side by side in the Java and answer different questions.
   * `config.isChannel()` is what `Spell.getCastTimeTicks` and `SpellCastingData` read to decide
   * that a spell pulses while held rather than casting and recovering; the tag is what
   * `SpellChangeStats` gates `channel_speed_perc` on. Reading the tag for both happens to agree
   * on all ten of this pack's player channels, and disagrees on five NPC spells that carry the
   * tag without the flag — so it was right by luck rather than by construction.
   */
  isChannel: boolean;
  /** `proj_count` on the first `projectile` act, when the spell has one. */
  projectileCount: number;
  /** `chain_count` on the first act that declares one. */
  chainCount: number;
};

/** The numbers after the caster's stats have had their say. */
export type SpellCalc = {
  castTicks: number;
  /** `CAST_SPEED_TICKS` after the sweep — the shared global-cooldown arm, floored at the GCD. */
  castSpeedTicks: number;
  /** `max(cooldownTicks, castSpeedTicks)` — `Spell.getEffectiveCooldownTicks`. */
  effectiveCooldownTicks: number;
  /** The raw `cast_speed_perc` the sweep produced, before it becomes a multiplier. */
  castSpeedPercent: number;
  /** `1 + max(-99, castSpeedPercent) / 100`. Above 1 is faster. */
  speedMulti: number;
  /** True when `cast_speed_ticks <= 0`, so casting this arms no shared cooldown. */
  offGlobalCooldown: boolean;
  cooldownTicks: number;
  chargeCooldownTicks: number;
  manaCost: number;
  energyCost: number;
  bonusProjectiles: number;
  bonusChains: number;
  areaMulti: number;
  durationMulti: number;
  /** `PROJECTILE_SPEED_MULTI` — `faster_projectiles`. The flight simulation needs it. */
  projectileSpeedMulti: number;
  /** `PROJECTILE_YAW_SPEED_MULTI` — how fast a turning projectile turns. */
  projectileYawSpeedMulti: number;
  pierce: boolean;
  nova: boolean;
  barrage: boolean;
  /**
   * `BlockSummonLimitGroup` — how many summoned blocks of each group may be alive at once, and
   * how many extra one cast places.
   *
   * `SummonBlockAction.getMaxSummons` is `max(1, data.getNumber(MAX_TOTEMS, 0))`, so the floor is
   * one rather than zero: a character with none of the stats still gets a totem, just never two.
   * `max_totems` and `max_banners` are the stats that raise it; nothing in this pack writes
   * `extra_totems` or `extra_banners`, so both are zero here and the field exists because the
   * count formula reads them.
   */
  maxTotems: number;
  maxBanners: number;
  extraTotems: number;
  extraBanners: number;
  /**
   * `BONUS_TOTAL_SUMMONS` — `SummonPetAction`'s cap on how many pets of this spell's summon type
   * may be alive. Reported rather than applied: summoned *entities* have no damage model yet, so
   * nothing can spend it. See the summon gap in `HANDOFF.md`.
   */
  bonusTotalSummons: number;
  /** `spell.config.summonType.id`. `"none"` means this spell's summons are not capped at all. */
  summonType: string;
};

export type SpellCalcInput = {
  snapshot: Snapshot;
  index: StatIndex;
  layers: LayerIndex;
  balance: Balance;
  /** The spell unit — support gems and the spell's innate stats included. */
  sheet: Sheet;
  spell: Record<string, unknown>;
  skill: SkillSetup;
  /**
   * The whole skill bar, for a spell that borrows its support gems from another Skill.
   *
   * Only the mana multiplier reads it, and only four of the 25 borrowing spells have a cost at
   * all — but leaving it out means the cost is computed from sockets the game does not consult.
   */
  equipped?: readonly SkillSetup[];
  characterLevel: number;
  config: BuildConfig;
  compat: Compat;
  /** Which exile effects are up, for the conditions the sweep's blocks are gated on. */
  effects: EffectState;
  diagnostics: Diagnostic[];
};

/**
 * Reads a spell's declared configuration.
 *
 * `setChargesAndRegen` force-overwrites `cooldown_ticks = 3` for every charge-based spell
 * (SpellConfiguration.java:81-87), so a charge spell's real rate lives in `charge_regen` and
 * the cooldown is a formality. `rateOf` handles that; this only reports what is declared.
 */
export function spellConfig(spell: Record<string, unknown>): SpellConfig {
  const config = asObject(spell["config"]) ?? {};
  const acts = findActs(spell);
  return {
    castTimeTicks: num(config["cast_time_ticks"]) ?? 0,
    isChannel: config["channel_skill"] === true,
    castSpeedTicks: num(config["cast_speed_ticks"]) ?? 0,
    procCooldownTicks: num(config["proc_cooldown_ticks"]) ?? 0,
    cooldownTicks: num(config["cooldown_ticks"]) ?? 20,
    chargeRegenTicks: num(config["charge_regen"]) ?? 0,
    charges: num(config["charges"]) ?? 0,
    timesToCast: Math.max(1, num(config["times_to_cast"]) ?? 1),
    manaCost: leveled(config["mana_cost"]),
    energyCost: leveled(config["ene_cost"]),
    tags: readTags(config["tags"]),
    projectileCount: acts.projectileCount,
    chainCount: acts.chainCount,
  };
}

/**
 * The `on_spell_stat_calc` sweep — `SpellStatsCalculationEvent` (:33-84).
 *
 * All 105 blocks in this pack sit at `data_modification` (priority 0) on the Source side and
 * are gated almost entirely on `spell_has_tag_*`, which `evaluateIfs` already answers. Only the
 * numbers are new.
 */
export function calculateSpell(input: SpellCalcInput): SpellCalc {
  const declared = spellConfig(input.spell);
  const event = new DamageEventState(input.layers);

  // `manamultilvl` — two factors, both applied to mana and energy alike
  // (SpellStatsCalculationEvent.java:50-59):
  //
  //     float manamultilvl = GameBalanceConfig.get().MANA_COST_SCALING.getMultiFor(lvl);
  //     var gem = Load.player(p).getSkillGemInventory().getSpellGem(spell);
  //     if (gem != null) { manamultilvl *= gem.getManaCostMulti(); }
  //
  // The second was missing for as long as the document could not say which support gems were
  // linked. It can now, and it is not a rounding error: most support gems charge 1.2x or 1.3x
  // and they compound, so five of them roughly doubles what a cast costs.
  const costMulti =
    multiFor(input.balance.manaCostScaling, input.characterLevel, input.balance.maxLevel) *
    supportCostMulti(input.snapshot, input.skill, input.equipped ?? []);

  event.data.setupNumber(EVENT.CAST_TICKS, declared.castTimeTicks);
  event.data.setupNumber(EVENT.CAST_SPEED_TICKS, declared.castSpeedTicks);
  // Both seeded at 0 by `SpellStatsCalculationEvent`, which is what makes `add_to_number`
  // meaningful for the 40 stats that write them.
  event.data.setupNumber(EVENT.CAST_SPEED_PERCENT, 0);
  event.data.setupNumber(EVENT.CHANNEL_SPEED_PERCENT, 0);
  event.data.setupNumber(EVENT.COOLDOWN_TICKS, declared.cooldownTicks);
  event.data.setupNumber(EVENT.CHARGE_COOLDOWN_TICKS, declared.chargeRegenTicks);
  event.data.setupNumber(EVENT.MANA_COST, costMulti * declared.manaCost);
  event.data.setupNumber(EVENT.ENERGY_COST, costMulti * declared.energyCost);
  event.data.setupNumber(EVENT.PROJECTILE_SPEED_MULTI, 1);
  event.data.setupNumber(EVENT.PROJECTILE_YAW_SPEED_MULTI, 1);
  event.data.setupNumber(EVENT.PROJECTILE_SPREAD_RANDOMNESS, 1);
  event.data.setupNumber(EVENT.DURATION_MULTI, 1);
  event.data.setupNumber(EVENT.AREA_MULTI, 1);
  event.data.setupNumber(EVENT.AGGRO_RADIUS_MULTI, 1);
  // Not seeded by the game — the effects that write them use `add_to_number`, which reads a
  // number that starts at 0. Seeding them keeps `getOriginalNumber` defined for both.
  event.data.setupNumber(EVENT.BONUS_PROJECTILES, 0);
  event.data.setupNumber(EVENT.BONUS_CHAINS, 0);
  // The summon limits, the same way: `getMaxSummons` reads `getNumber(key, 0)` and floors the
  // result at 1, so a character with no `max_totems` stat keeps exactly one totem alive.
  event.data.setupNumber(EVENT.MAX_TOTEMS, 0);
  event.data.setupNumber(EVENT.MAX_BANNERS, 0);
  event.data.setupNumber(EVENT.EXTRA_TOTEMS, 0);
  event.data.setupNumber(EVENT.EXTRA_BANNERS, 0);
  event.data.setupNumber(EVENT.BONUS_TOTAL_SUMMONS, 0);
  event.data.setString(EVENT.SPELL, input.skill.spellId);
  event.data.setString(EVENT.ELEMENT, "Physical");
  // `this.data.setString(EventData.SUMMON_TYPE, spell.config.summonType.id)`
  // — SpellStatsCalculationEvent.java:45. The snapshot writes the enum constant (`"SPIDER"`) and
  // the five `summon_type_is_*` conditions compare against `SummonType.id`, which is its lower
  // case. Without this every `max_<type>_summons` gate failed and every summon cap read zero.
  event.data.setString(EVENT.SUMMON_TYPE, summonTypeOf(input.spell));

  const ctx: DamageCtx = {
    snapshot: input.snapshot,
    index: input.index,
    balance: input.balance,
    // Nothing in this event reads a compat field — they all describe damage — but the context
    // type wants one, so it takes the caller's rather than inventing a shape.
    compat: input.compat,
    event,
    source: input.sheet,
    target: new Map(),
    sourceLevel: input.characterLevel,
    targetLevel: input.characterLevel,
    spell: input.spell,
    spellId: input.skill.spellId,
    spellTags: new Set(declared.tags),
    config: input.config,
    effects: input.effects,
    diagnostics: input.diagnostics,
    report: (severity, code, path, message) =>
      input.diagnostics.push({ severity, code, path, message }),
    reportedConditions: new Set(),
    reportedEffects: new Set(),
    pinnedBooleans: new Set(),
    disableSourceStats: false,
    sourceIsTarget: false,
  };

  type Entry = { priority: number; statId: string; run: () => void };
  const queue: Entry[] = [];

  for (const [statId, stat] of input.sheet) {
    const def = input.index.get(statId);
    for (const block of def?.effects ?? []) {
      // Source only: `SpellStatsCalculationEvent` passes the caster as both sides, and every
      // one of the pack's 105 blocks declares Source.
      if (block.side !== "Source") continue;
      if (!block.events.includes(ON_SPELL_STAT_CALC)) continue;
      if (stat.value === 0) continue;
      queue.push({
        priority: datapackPriority(block.order) ?? UNKNOWN_ORDER_PRIORITY,
        statId,
        run: () => {
          const weight = evaluateIfs(ctx, block.ifs, { statId, value: stat.value, element: def?.element }, "Source");
          if (weight <= 0) return;
          const shape = input.index.shapeOf(statId);
          for (const effectId of block.effects) {
            applyStatEffect(
              ctx,
              effectId,
              { statId, value: stat.value, dmgMulti: stat.dmgMulti, multiUseType: shape.multiUseType },
              "Source",
              weight,
            );
          }
        },
      });
    }
  }

  queue.sort((a, b) => (a.priority === b.priority ? a.statId.localeCompare(b.statId) : a.priority - b.priority));
  for (const item of queue) item.run();

  // The tag here, deliberately: `channel_speed_perc` is gated by
  // `StatConditions.SPELL_HAS_TAG.get(SpellTags.channel)`, not by the config flag.
  return clampSpellCalc(event, declared, input.balance, declared.tags.includes("channel"));
}

/** `spell.config.summonType.id` — `SummonType.NONE.id` for the 411 spells that summon nothing. */
function summonTypeOf(spell: Record<string, unknown>): string {
  const config = asObject(spell["config"]);
  const declared = config?.["summonType"];
  return typeof declared === "string" && declared.length > 0 ? declared.toLowerCase() : "none";
}

/**
 * `SpellStatsCalculationEvent.activate` and `Spell.getCastTimeTicks` (:205-208), at 6.4.13.
 *
 *     int cd = (int) Mth.clamp(data.getNumber(COOLDOWN_TICKS).number,
 *             config.cooldown_ticks * MIN_SPELL_COOLDOWN_MULTI, 1000000);
 *     ... same for CHARGE_COOLDOWN_TICKS against charge_regen ...
 *
 *     float percent = data.getNumber(CAST_SPEED_PERCENT).number;
 *     if (spell.is(SpellTags.channel)) {
 *         percent = percent * CHANNEL_GENERAL_SPEED_TRANSFER
 *                 + data.getNumber(CHANNEL_SPEED_PERCENT).number;
 *     }
 *     float multi = 1 + Math.max(-99f, percent) / 100f;
 *
 *     data.getNumber(CAST_SPEED_TICKS).number =
 *             Math.max(GLOBAL_COOLDOWN_TICKS, data.getNumber(CAST_SPEED_TICKS).number / multi);
 *     data.getNumber(CAST_TICKS).number = data.getNumber(CAST_TICKS).number / multi;
 *
 * — read out of `Mine_and_Slash-1.20.1-6.4.13.jar`, which is the version this snapshot was
 * extracted from; `reference/mns-src` is 6.4.8 and has none of it.
 *
 * The cast-time floor is `times_to_cast`, not 0 — a spell that casts five times over its
 * duration needs at least five ticks to do it in.
 */
function clampSpellCalc(event: DamageEventState, declared: SpellConfig, balance: Balance, channel: boolean): SpellCalc {
  const floorFor = (base: number): number => base * balance.minSpellCooldownMulti;

  const rawPercent = event.data.getNumber(EVENT.CAST_SPEED_PERCENT);
  const percent = channel
    ? rawPercent * balance.channelSpeedTransfer + event.data.getNumber(EVENT.CHANNEL_SPEED_PERCENT)
    : rawPercent;
  // The -99 floor is the game's, and it is what stops a slow enough build from dividing by zero
  // or turning the cast around: at -99% a cast takes 100x as long, never negative time.
  const speedMulti = 1 + Math.max(-99, percent) / 100;

  const castSpeedTicks = Math.max(
    balance.globalCooldownTicks,
    event.data.getNumber(EVENT.CAST_SPEED_TICKS) / speedMulti,
  );
  const cooldownTicks = Math.trunc(
    clamp(event.data.getNumber(EVENT.COOLDOWN_TICKS), floorFor(declared.cooldownTicks), 1_000_000),
  );
  // `Spell.getCastTimeTicks` reads the number the event divided, then clamps and ceils it.
  const castTicks = clamp(
    Math.ceil(event.data.getNumber(EVENT.CAST_TICKS) / speedMulti),
    declared.timesToCast,
    10000,
  );
  // `SpellConfiguration.isOffGlobalCooldown()` — the *declared* field, not the calculated one,
  // which matters because the calculated one is floored at the GCD and so is never 0.
  const offGlobalCooldown = declared.castSpeedTicks <= 0;

  return {
    castTicks,
    castSpeedTicks: offGlobalCooldown ? 0 : castSpeedTicks,
    // `Spell.getEffectiveCooldownTicks` — `Math.max(getCooldownTicks(ctx), getCastSpeedTicks(ctx))`.
    // `getCastSpeedTicks` ceils, so the max is taken against the ceiling.
    effectiveCooldownTicks: offGlobalCooldown
      ? cooldownTicks
      : Math.max(cooldownTicks, Math.ceil(castSpeedTicks)),
    castSpeedPercent: percent,
    speedMulti,
    offGlobalCooldown,
    cooldownTicks,
    chargeCooldownTicks: Math.trunc(
      clamp(event.data.getNumber(EVENT.CHARGE_COOLDOWN_TICKS), floorFor(declared.chargeRegenTicks), 1_000_000),
    ),
    manaCost: Math.max(0, event.data.getNumber(EVENT.MANA_COST)),
    energyCost: Math.max(0, event.data.getNumber(EVENT.ENERGY_COST)),
    bonusProjectiles: Math.trunc(event.data.getNumber(EVENT.BONUS_PROJECTILES)),
    bonusChains: Math.trunc(event.data.getNumber(EVENT.BONUS_CHAINS)),
    areaMulti: event.data.getNumber(EVENT.AREA_MULTI),
    durationMulti: event.data.getNumber(EVENT.DURATION_MULTI),
    projectileSpeedMulti: event.data.getNumber(EVENT.PROJECTILE_SPEED_MULTI, 1),
    projectileYawSpeedMulti: event.data.getNumber(EVENT.PROJECTILE_YAW_SPEED_MULTI, 1),
    pierce: event.data.getBoolean(EVENT.PIERCE),
    nova: event.data.getBoolean(EVENT.NOVA),
    barrage: event.data.getBoolean(EVENT.BARRAGE),
    // `getMaxSummons` floors at 1, so the floor belongs here rather than at the use site — a
    // build with no `max_totems` still gets one totem.
    maxTotems: Math.max(1, Math.trunc(event.data.getNumber(EVENT.MAX_TOTEMS))),
    maxBanners: Math.max(1, Math.trunc(event.data.getNumber(EVENT.MAX_BANNERS))),
    extraTotems: Math.trunc(event.data.getNumber(EVENT.EXTRA_TOTEMS)),
    extraBanners: Math.trunc(event.data.getNumber(EVENT.EXTRA_BANNERS)),
    bonusTotalSummons: Math.trunc(event.data.getNumber(EVENT.BONUS_TOTAL_SUMMONS)),
    summonType: event.data.getString(EVENT.SUMMON_TYPE) || "none",
  };
}

// ---------------------------------------------------------------------------
// The rate
// ---------------------------------------------------------------------------

export type CastRate = {
  /** Seconds from starting one cast to being able to start the next. */
  cycleSeconds: number;
  castSeconds: number;
  /** The recovery half of the cycle — whichever of cooldown, cast speed or charge regen won. */
  cooldownSeconds: number;
  /** How many times the spell fires per cycle — `times_to_cast`. */
  castsPerCycle: number;
  /** True when the rate came from charge regeneration rather than the cooldown. */
  chargeBased: boolean;
  /** True when `cast_speed_ticks`, not the spell's own cooldown, is what set the recovery. */
  castSpeedBound: boolean;
  /** True when the figure is a held channel's pulse interval rather than a cast-and-recover cycle. */
  channelled: boolean;
  /** Seconds this cast arms the shared global cooldown for. 0 when the spell is off it. */
  globalCooldownSeconds: number;
  /**
   * Whether a player can press this at all.
   *
   * `cast_speed_ticks > 0` is the test — 340 of the pack's 432 spells pass it. The rest are
   * procs, pet attacks and triggered variants: the `cursed_*` family, the curses,
   * `mirror_image`, `power_surge`, `martyrdom`, `eighth_gate`, `blood_harvest`. They reach the
   * world when a stat casts them, never when you press a key.
   */
  castable: boolean;
  /**
   * True when `cycleSeconds` is `proc_cooldown_ticks` rather than a cast cycle.
   *
   * This is a **ceiling, not a rate**. It is how fast the spell could possibly repeat if
   * something triggered it at every opportunity; what actually paces it is whatever procs it,
   * and that depends on the skill you are pressing. `DpsResult.procs` is where a real rate
   * lives — see `resolveProcs`.
   */
  procPaced: boolean;
};

/**
 * One cast cycle, in seconds.
 *
 * `onSpellCastFinished` calls `setCooldownOnCasted`, so recovery starts when the cast
 * *finishes* rather than alongside it — the two are sequential. What recovery is has changed
 * since 6.4.8: `setCooldownOnCasted` now puts `Spell.getEffectiveCooldownTicks` on the spell,
 * which is `max(cooldown_ticks, cast_speed_ticks)`, so a spell declaring no cooldown at all is
 * still limited by its cast speed.
 *
 * A charge spell is the exception. `setChargesAndRegen` force-overwrites `cooldown_ticks = 3`
 * when charges are declared (SpellConfiguration.java:81-87), so the number that governs how
 * often it can be cast is the charge regeneration, not the cooldown — but the global cooldown
 * still applies underneath it.
 *
 * A **channel** is the other exception, and it is a different shape rather than a different
 * number. `SpellCastingData.onTimePass` runs `tryChannelPulse` when `castTickLeft` reaches
 * zero, and that method casts the spell and immediately re-arms
 * `castTickLeft = getCastTimeTicks(ctx)`. It never goes through `tryCast` or
 * `onSpellCastFinished`, so no cooldown is set and no global cooldown is armed between pulses:
 * a held channel repeats every `CAST_TICKS` and nothing else. Holding it is what the player
 * does, so that is what is reported — `whirlwind` recovering for its cooldown between swings is
 * a cycle the game never makes you pay.
 */
export function rateOf(calc: SpellCalc, declared: SpellConfig): CastRate {
  // The flag here, not the tag: whether a spell pulses while held is `config.isChannel()`.
  const channelled = declared.isChannel;
  const chargeBased = !channelled && declared.charges > 0 && calc.chargeCooldownTicks > 0;
  const recovery = channelled
    ? 0
    : chargeBased
      ? Math.max(calc.chargeCooldownTicks, calc.castSpeedTicks)
      : calc.effectiveCooldownTicks;

  // A spell with no cast speed and no cooldown of its own has no cycle to compute, and the
  // floor below would give it one tick — 20 casts a second, which is how `cursed_raging_dragon`
  // came to report 27 million DPS and take eight of the pack's top ten. It is not castable at
  // all; the only thing that limits how often it happens is `proc_cooldown_ticks`, the same
  // field `procs.ts` caps a proc's rate with. Using it here makes the standalone figure a
  // stated ceiling instead of an artefact of the floor.
  const castable = !calc.offGlobalCooldown;
  const procPaced = !castable && !channelled && recovery <= 0;
  const procCeiling = declared.procCooldownTicks > 0 ? declared.procCooldownTicks : DEFAULT_PROC_COOLDOWN_TICKS;

  // A channel pulse is one `CAST_TICKS`; anything else casts and then recovers, in that order.
  // A proc-paced spell is neither: it is not cast, so its cast time is not *added* to a recovery
  // it does not have. What limits it is `is_<spell>_not_on_cd`, which `procs.ts` reads as a cap of
  // `20 / proc_cooldown_ticks` per second — a repeat interval, measured from the last time it
  // fired. The cast time can only bind when it is the longer of the two.
  const ticks = procPaced
    ? Math.max(calc.castTicks, procCeiling)
    : Math.max(channelled ? 1 : 0, calc.castTicks + recovery);

  return {
    castable,
    procPaced,
    cycleSeconds: ticks / TICKS_PER_SECOND,
    castSeconds: calc.castTicks / TICKS_PER_SECOND,
    cooldownSeconds: (procPaced ? procCeiling : recovery) / TICKS_PER_SECOND,
    castsPerCycle: declared.timesToCast,
    chargeBased,
    castSpeedBound: !channelled && !calc.offGlobalCooldown && calc.castSpeedTicks >= calc.cooldownTicks,
    channelled,
    globalCooldownSeconds: channelled ? 0 : calc.castSpeedTicks / TICKS_PER_SECOND,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** `LevelScalingConfig.getMultiFor`, for the one curve that is not a `StatScaling`. */
/**
 * `SocketedGem.getManaCostMulti` (SocketedGem.java:132-142).
 *
 *     float multi = 1;
 *     for (SkillGemData data : this.getSupportDatas()) { multi *= data.getSupport().manaMulti; }
 *     return multi;
 *
 * A product, not a sum, and read off the support gem's registry entry rather than off the
 * linked item — so it is the same for every copy of a gem however it rolled. `manaMulti`
 * defaults to 0.25 in the Java, which no shipped gem uses; an entry that is somehow missing the
 * field is left at 1 rather than given a discount the game does not grant.
 */
function supportCostMulti(
  snapshot: Snapshot,
  skill: SkillSetup,
  equipped: readonly SkillSetup[],
): number {
  // A borrowing spell is costed off the sockets it actually uses, which are the lender's —
  // `MercenaryData` picks the slot the same way (`usesSupportGemsFromAnotherSpell() ?
  // getSpellUsedForSuppGems().GUID() : ...`). No lender on the bar means no sockets at all.
  const sockets = supportSocketsFor(snapshot, skill, equipped);
  if (sockets === undefined) return 1;
  let multi = 1;
  for (const link of supportLinks(sockets.skill)) {
    const data = entry(snapshot, CATEGORY.supportGem, link.id)?.data;
    const declared = data === undefined ? undefined : num(data["manaMulti"]);
    if (declared !== undefined) multi *= declared;
  }
  return multi;
}

function multiFor(curve: Balance["manaCostScaling"], level: number, maxLevel: number): number {
  const lvl = curve.capToMaxLvl ? clamp(level, 1, maxLevel) : level;
  return curve.baseScaling + curve.perLevelScaling * (lvl - 1);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A `LeveledValue` in a config block. Only the base matters for a cost. */
function leveled(value: unknown): number {
  if (typeof value === "number") return value;
  const obj = asObject(value);
  if (!obj) return 0;
  return num(obj["base"]) ?? num(obj["min"]) ?? 0;
}

/** `TagList<SpellTag>` serialises as `{ tags: [...] }`, not as a bare array. */
function readTags(value: unknown): string[] {
  const list = asObject(value)?.["tags"] ?? value;
  return Array.isArray(list) ? list.filter((t): t is string => typeof t === "string") : [];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The first `projectile` act's `proj_count`, and the first `chain_count` anywhere.
 *
 * Both live in the `attached` component tree rather than in `config`, alongside the `damage`
 * act `simulateHit` already walks for. `skill-model.ts` enumerates every one of them; this
 * stays as the headline pair the spell unit reports.
 */
function findActs(spell: Record<string, unknown>): { projectileCount: number; chainCount: number } {
  let projectileCount = 0;
  let chainCount = 0;

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = asObject(node);
    if (!obj) return;
    const map = asObject(obj["map"]) ?? obj;
    if (projectileCount === 0) projectileCount = num(map["proj_count"]) ?? 0;
    if (chainCount === 0) chainCount = num(map["chain_count"]) ?? 0;
    for (const value of Object.values(obj)) visit(value);
  };
  visit(spell["attached"]);

  return { projectileCount, chainCount };
}
