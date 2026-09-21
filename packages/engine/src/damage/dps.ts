/**
 * Damage per second.
 *
 * The game computes none — `ValueCalculation.getShortTooltip` shows a hit, a cast time and a
 * cooldown as three separate facts and never divides one by the other. So this is the one part
 * of the pipeline that is a *decision* rather than a port, and the decision is made in three
 * pieces, each of which is derived from the data as far as the data goes:
 *
 *   1. **What a cast produces** — `skill-model.ts` enumerates every `damage` act, what carries
 *      it (`on_cast`, a projectile, a summoned block) and how many times that carrier fires it.
 *      A cast of `raging_dragon` is a slam plus nine projectiles pulsing fifteen times each,
 *      not one hit;
 *   2. **How much of it lands** — `geometry.ts` flies each projectile with the game's own
 *      integration and counts the pulses that reach the target where it stands;
 *   3. **How often you can cast** — `spell-calc.ts`, ported to 6.4.13, where `cast_speed_ticks`
 *      and the shared global cooldown replaced `cast_ticks + cd_ticks`.
 *
 * Each source resolves its own damage event, because each has its own `value_calculation` and
 * its own element — `raging_dragon_slam` is 1.575–2.25× weapon damage and `raging_dragon` is
 * 3.15–4.5×, and reporting either as the other is wrong by a factor of two before the count is
 * even considered.
 *
 * ## Full DPS
 *
 * A skill marked `includeInFullDps` joins a second figure that models the rotation, in the same
 * spirit as Path of Building's. It is not a sum: every skill in the pack arms the same
 * `GLOBAL_COOLDOWN` key when it is cast (`SpellCastingData.armGlobalCooldown`), so casting a
 * combo extender to enable a finisher costs the finisher real time. `fullDps` therefore divides
 * the damage of one pass through the ticked skills by how long that pass actually takes — which
 * is what makes an extender-plus-finisher rotation read lower than the finisher alone, correctly.
 *
 * Sources that keep dealing damage after the cast — a summoned ground effect, a projectile still
 * in flight — are reported separately as `persistentDps`, because those genuinely do overlap the
 * next cast rather than queueing behind it.
 */

import type { Snapshot } from "@cte2/extractor";
import type { BuildConfig, BuildDoc, Diagnostic, ElementName, SkillSetup } from "@cte2/schema";
import { isSkillEnabled } from "@cte2/schema";

import type { Balance } from "../balance.js";
import { balance } from "../balance.js";
import { calculate, resolveEffects, type EngineResult } from "../calculate.js";
import { spellRanks, withLearnedRank } from "../collect/spell.js";
import type { Compat } from "../compat.js";
import { ORIGINAL_MODE } from "../compat.js";
import type { StatIndex } from "../stat-def.js";
import { statIndex } from "../stat-def.js";
import type { AilmentResult } from "./ailments.js";
import { auraCutoffShare, auraSources } from "./auras.js";
import type { Sheet } from "./ctx.js";
import { effectDurationTicks } from "./effect-duration.js";
import { layerIndex, type LayerIndex } from "./layers.js";
import {
  coverageOf,
  DEFAULT_PLACEMENT,
  type Coverage,
  type TargetPlacement,
} from "./geometry.js";
import {
  declaresDamage,
  gatedEffectIds,
  potionConditionKey,
  skillModel,
  type Carrier,
  type DamageSource,
  type SkillModel,
} from "./skill-model.js";
import {
  calculateSpell,
  rateOf,
  spellConfig,
  TICKS_PER_SECOND,
  type CastRate,
  type SpellCalc,
  type SpellConfig,
} from "./spell-calc.js";
import type { ProcHit, RestoreRecord } from "./ctx.js";
import { planCombo, resolveCombo, type ComboChain } from "./combo.js";
import { resolveSummons, summonDps, type SummonOutput } from "./summons.js";

/**
 * The component group a pet's swing drives.
 *
 * `Spell.DEFAULT_EN_NAME`, which `PetAttackUTIL.tryAttack` passes to `tryActivate` — the pet's
 * basic attack has no `on_cast` half at all, so this is the only way into it.
 */
const PET_ATTACK_GROUP = "default_entity_name";
import {
  budget,
  leech,
  resourceSpent,
  resources,
  type Leech,
  type ResourceBudget,
  type ResourceId,
} from "./resources.js";
import { casterBuffUpkeep, targetDebuffUpkeep, type EffectState } from "./effect-state.js";
import {
  procDps,
  procSourcesFor,
  resolveProcs,
  rotationProcs,
  type Proc,
} from "./procs.js";
import { simulateHit, type DamageOptions, type DamageResult } from "./simulate.js";

export type DpsOptions = DamageOptions & {
  /** Where the enemy stands. Defaults to `DEFAULT_PLACEMENT` — melee range, dead ahead. */
  placement?: TargetPlacement;
  /**
   * How many enemies are in range, for the pack figure.
   *
   * It scales `packDps` only and never the single-target number. Defaults to 1. Every enemy is
   * assumed to be placed like the one in `placement`, which overstates a pack spread across a
   * wide area and understates one standing on top of you.
   */
  packSize?: number;
  /**
   * Force a source's coverage instead of deriving it, keyed by `DamageSource.id`.
   *
   * The simulation is the default because it is a derivation; this exists for the cases where
   * you know better than it does — a homing projectile, a mob that will not stand still.
   */
  coverageOverrides?: Record<string, number>;
  /**
   * Resolve what this skill's hits proc. On by default; a nested call turns it off.
   *
   * Each proc costs a `simulateDps` of the spell it casts, and a procced spell's own procs are
   * not followed — otherwise a build with a proc on every stat would multiply out.
   */
  procs?: boolean;
  /**
   * The component group the model walks from, when it is not `on_cast`.
   *
   * Only a summon's basic attack needs it: the pet's swing enters `default_entity_name` at an
   * `on_hit` context rather than being cast, so `summons.ts` asks for that group by name. See
   * {@link skillModel}, which quotes the two lines of `PetAttackUTIL` this comes from.
   */
  entryGroup?: string;
  /**
   * Resolve what this skill's summons do. On by default; a nested call turns it off, the same
   * way `procs` does and for the same reason.
   */
  summons?: boolean;
  /**
   * The character run this figure should be built on, when the caller already has it.
   *
   * `simulateDps` otherwise resolves the exile-effect fixed point itself, which is the single
   * most expensive thing it does — 35 ms on an eight-skill level-100 build. Supply it only when
   * the document genuinely produces this run: the planner does, when it is pricing a **support
   * gem**, because a support gem's stats land on the spell unit and never on the character sheet
   * (`PlayerData.calcSpellUnit` builds one per spell on top of `allStatsWithoutSuppGems`). Any
   * change that touches gear, perks, auras or the skill bar itself invalidates it.
   *
   * The `preferred` tiebreak `resolveEffects` is given is the *spell's* gates, so it is the same
   * run for every gem linked to the same skill, which is exactly the sweep this exists for.
   */
  characterRun?: EngineResult;
};

/** One `damage` act, resolved: what it hits for, how often, and how much of it lands. */
export type SourceResult = {
  source: DamageSource;
  /** The damage event for this act's own `value_calculation` and element. */
  hit: DamageResult;
  coverage: Coverage;
  /** `average.total × coverage.hitsPerCast` — what this source contributes to one cast. */
  damagePerCast: number;
  /** The same with the crit branch pinned. */
  critDamagePerCast: number;
  /**
   * True when this source keeps firing after the cast is over — a carrier that outlives the
   * cast cycle. Those overlap the next cast rather than queueing behind it.
   */
  persistent: boolean;
  /**
   * The share of `damagePerCast` a sustained rotation actually collects. 1 for almost everything.
   *
   * Below 1 only for a carrier in a `BlockSummonLimitGroup`, where `enforceSummonLimit` culls the
   * oldest of the group on every cast. A totem that lives eight seconds against a button that
   * comes back every half second does *not* put fifteen totems on the field — it puts one, and
   * pressing the button again throws the first one away before it has pulsed. See {@link limit}.
   */
  sustained: number;
  /**
   * Why `sustained` is below 1, when it is.
   *
   * `periodSeconds` is the pace this source is really delivered at: you cannot place the
   * `maxAlive + 1`-th without destroying one, so the fastest sustainable placement is one per
   * `carrier life / maxAlive` — or the button's own cycle, whichever is slower.
   */
  limit?: { group: string; maxAlive: number; periodSeconds: number };
  /** Seconds from the cast until this source has finished firing. */
  durationSeconds: number;
  /**
   * How many casts' worth of this source are alive at once, once casting has been sustained.
   *
   * `durationSeconds / cycleSeconds`. Above 1 means the previous cast is still dealing damage
   * when the next goes out — nine dragons still circling as nine more are thrown.
   */
  concurrentCasts: number;
  /** `concurrentCasts × carriersPerCast` — carriers in the world at once, for a projectile. */
  concurrentCarriers: number;
};

/**
 * How long a press of a buff keeps its effect on you.
 *
 * `infinite` is the `-1` every stance, aura and toggle in this pack writes: you press it once
 * and it stays until you press it again, so there is nothing for a duration stat to lengthen and
 * `durationSeconds` is `Infinity` rather than a large number.
 */
export type BuffDuration = {
  /** The effect whose duration is the longest of the ones this press puts on you. */
  effectId: string;
  /** `potion_dur / 20`, after the `on_exile_effect` sweep. */
  durationSeconds: number;
  /** The same before it — what the pack's JSON declares, for the "what did that buy me" row. */
  declaredSeconds: number;
  infinite: boolean;
};

/**
 * What pressing the button does to *you*.
 *
 * Ten spells in this pack declare a `damage` act at a `self` selector and charge you for the
 * cast — `asura` takes 50% of your health plus 50% of your magic shield, `forbidden_rite` and
 * `eighth_gate` the same idea. It is a real hit with a real event: your `dmg_received`, armour
 * and resists all apply, and the log shows it as a block of `[Target]` lines.
 *
 * Two things make it unlike any other number on this result, and both are the game's:
 *
 *  - **you take none of your own offence.** `no_attacker_stats_on_selfdmg` is a base stat every
 *    character in this pack has; on a hit where `source_is_target`, `disable_attacker_stats`
 *    switches off the attacker half of the sweep, so your `attack_damage` and `spell_damage`
 *    never touch it.
 *  - **you cannot dodge or block it.** `DamageEvent.canAvoidHit()` is `source != target`, and
 *    `DodgeRating`, `BlockChance` and `SpellDodgeEffect` all check it first. Mitigation applies;
 *    avoidance does not.
 *
 * It is never netted off `dps`. The damage you deal and the damage you pay are different
 * questions, and a single number that mixed them would answer neither.
 */
export type SelfDamage = {
  /** The self-targeted sources, each with its own trace when one was asked for. */
  sources: SourceResult[];
  /** One cast's worth, after your own mitigation — what you actually lose. */
  perCast: number;
  /** The same before any mitigation: the `value_calculation`'s own number. */
  rawPerCast: number;
  /** `perCast` at the cast rate — the drain to set against health regeneration and leech. */
  perSecond: number;
  /** `1 - perCast / rawPerCast`, the share your defences took off. 0 when there is nothing to take. */
  mitigated: number;
  /**
   * The share of your combined health and magic shield at which the effect responsible takes
   * itself off, when one does.
   *
   * Holy Fire, Sanguine, Abyss and Plague all carry a `remove_<id>_when_very_low` stat, so their
   * failure mode is the aura going out rather than the character dying. A sustain figure that
   * only counted down to zero would be answering a question the game never asks.
   */
  cutoffShare?: number;
};

/** The counts a caller needs to understand a multi-projectile spell, none of them assumed. */
export type MultiHitInfo = {
  projectiles: number;
  baseProjectiles: number;
  bonusProjectiles: number;
  chains: number;
  pierce: boolean;
  nova: boolean;
  barrage: boolean;
};

export type ResourceCost = {
  manaPerCast: number;
  energyPerCast: number;
  manaPerSecond: number;
  energyPerSecond: number;
  /**
   * Per-second regeneration of the pool the mana cost actually comes out of.
   *
   * `<r>_regen` is only the first of three contributions — `<r>_per_sec` scales with the pool and
   * the `on_restore_resource` percents multiply both — so this is `resources.ts`'s figure rather
   * than a raw stat read. See {@link manaSpentAs}.
   */
  manaRegen: number;
  energyRegen: number;
  /**
   * What the hits put back, per pool, after the leech cap.
   *
   * Leech is banked rather than restored — `<r>_leech_cap` percent of the pool pays out a second,
   * base 5 — so a build that leeches more than the cap is throwing the surplus away. The entries
   * say which, and `unrated` names the leech the engine can see but cannot rate.
   */
  leech: Leech;
  /**
   * Income against spend, pool by pool. The row with a negative `netPerSecond` is the one that
   * stops you casting, and it says how long a full pool lasts.
   */
  budget: ResourceBudget[];
  /**
   * Which pool pays the mana cost: `mana`, or `blood` when the Blood Magic game changer is on.
   *
   * `BloodUserEffect` rewrites the resource on the *spend* event and leaves regeneration alone,
   * so a blood build is sustained by `hp_resto_to_blood` rather than by mana regeneration — and
   * comparing the cost against mana regen would say a build is fine when it is not.
   */
  manaSpentAs: ResourceId;
  /**
   * Which pool pays the energy cost: `energy`, or `blood` under the same game changer.
   *
   * `canActivate` accepts energy as well as mana in 6.4.13, so a blood mage's weapon skills come
   * out of blood too. That is the whole ledger for a blood weapon-skill build: taking Blood Magic
   * zeroes the energy pool, and every energy cost moves onto blood beside the mana ones.
   */
  energySpentAs: ResourceId;
  /** Every pool in {@link budget} keeps up. */
  sustainable: boolean;
};

export type DpsResult = {
  spellId: string;
  /**
   * The largest single source's hit, kept so every existing caller that wanted "the hit" still
   * gets a sensible one. For `raging_dragon` that is one dragon pulse, not the whole cast.
   */
  hit: DamageResult;
  /**
   * Which of {@link sources} {@link hit} came from, when it came from one at all.
   *
   * A multi-hit skill has no single "the hit": `meteor_arrow` is an arrow and a meteor, and a
   * breakdown of one of them is not a breakdown of the other. A caller offering the choice
   * needs to know which one it is already showing, and deriving that by comparing damage a
   * second time would be a second chance to disagree with this one.
   */
  headlineSourceId?: string;
  /** Every `damage` act this cast produces, in the order the tree declares them. */
  sources: SourceResult[];
  model: SkillModel;
  declared: SpellConfig;
  calc: SpellCalc;
  rate: CastRate;
  multiHit: MultiHitInfo;
  cost: ResourceCost;
  placement: TargetPlacement;
  /**
   * Which exile effects this build can have up, which are assumed up, and what granted them.
   *
   * The toggle list a UI needs, and the record of what the figure assumed. A gate that failed is
   * in `model.blockedBy` rather than here.
   */
  effects: EffectState;
  /**
   * How far this skill reaches, when it reaches nothing where the target is standing.
   *
   * Only set for a skill with damage sources that all miss at `placement`: a melee area of
   * radius 1.5 measured against a mob two blocks away correctly reports nothing, and "nothing"
   * on its own is indistinguishable from a modelling failure. It is the farthest distance at
   * which anything at all still lands, derived by sweeping the same coverage the figure came
   * from — the model's own answer rather than a second rule.
   */
  reachDistance?: number;
  /** Total damage one cast puts on the target, across every source. */
  damagePerCast: number;
  critDamagePerCast: number;
  /**
   * The share of {@link damagePerCast} that came from a permanent aura rather than from the cast.
   *
   * Inside `damagePerCast`, not beside it. An aura's damage is billed to the button that puts it
   * up — that is what makes Holy Fire's figure appear on Holy Fire's row at all — but it is not
   * *produced* by the press: `auras.ts` gives a permanent carrier a life of exactly one cast
   * cycle so that `damagePerCast / cycleSeconds` comes out as the rate the aura really pulses at,
   * whatever the cycle happens to be. That arithmetic holds only against this skill's own cycle.
   * A rotation has a different one, so {@link simulateFullDps} takes this term out of the
   * per-press damage and adds {@link auraDps} back on its own clock instead.
   *
   * 0 for everything that holds no permanent damaging effect, which is 428 of the 432 spells.
   */
  auraDamagePerCast: number;
  auraCritDamagePerCast: number;
  /**
   * What the held auras deal per second, on their own fixed timing.
   *
   * `holy_fire` pulses every 10 ticks for as long as it is up: twice a second, whether you are
   * mid-cast, on cooldown or standing still. It is a term of {@link dps} already; it is broken
   * out because it is the one part of this figure a cast rate does not pace.
   */
  auraDps: number;
  /** The same with the crit branch pinned, so a rotation's all-crit figure has one to add. */
  auraCritDps: number;
  /** `damagePerCast / rate.cycleSeconds` — the rate at which the button comes back. */
  dps: number;
  critDps: number;
  /**
   * The chain you have to press to get this skill to fire at all, when it is one.
   *
   * A finisher's own cycle is how often the button is *ready*, not how often it does anything:
   * `raging_dragon` consumes `combo_extender`, which only `spirit_offensive` grants, which
   * consumes `combo_linker`, and so on back to a basic attack. `rate.cycleSeconds` is 0.75s and
   * a pass of the chain is four times that. Undefined for a skill you can simply press.
   */
  combo?: ComboChain;
  /**
   * `dps` paced by the combo chain instead of by the button.
   *
   * The damage this skill contributes when you play it the way it has to be played. The chain's
   * own casts are damage too — {@link simulateFullDps} is what adds those up — so this is the
   * finisher's share, not the rotation's total.
   */
  comboDps?: number;
  /** The share of `dps` coming from sources that outlive the cast cycle. */
  persistentDps: number;
  /**
   * Spells the build casts for you while this skill is the one you are pressing.
   *
   * Empty when nothing on the sheet carries a `proc_spell` effect this skill can trigger — the
   * `spell_has_tag` gates are what decide that, and they are evaluated against this skill.
   */
  procs: Proc[];
  /** `sum(procs.dps)`, kept separate from `dps` because it is a different spell's damage. */
  procDps: number;
  /**
   * The pets this skill puts out, and what each one's swing is worth.
   *
   * Empty for everything that summons nothing. A summon skill's own `dps` is usually zero — it
   * declares no `damage` act at all — so for those this is the entire output of the button.
   */
  summons: SummonOutput[];
  /** `sum(summons.dps)`, separate from `dps` for the same reason `procDps` is: another clock. */
  summonDps: number;
  /** What is in the air at once, and how long the number takes to get there. */
  overlap: Overlap;
  /** `dps` against `packSize` enemies. */
  packDps: number;
  /** Ailment damage per second, summed. Not part of `dps` — it lands on its own clock. */
  ailmentDps: number;
  /**
   * The share of {@link ailmentDps} that is a Shatter or a Shock rather than a tick.
   *
   * Inside `ailmentDps`, not beside it: adding the two would double-count. It is broken out
   * because the two halves behave nothing alike and a player choosing between them needs to see
   * which is which. A bleed is a rate that is either up or it is not; a Shatter is a pool that
   * fills off every freeze you land and empties in one spike, so the stats that move it are
   * `freeze_chance` and `freeze_proc_chance` rather than `dot_speed` and `bleed_duration`.
   */
  ailmentProcDps: number;
  /**
   * How big that spike is: the pool one Shatter or Shock releases, at steady state.
   *
   * The hit that tips it lands as well, so the whole spike is `hit.average.total` plus this.
   * They are two events — `EntityAilmentData.shatterAccumulated` fires an
   * `EventBuilder.ofDamage` of its own — and are reported as two figures for that reason.
   *
   * Zero for a build with no proc chance, which is the honest answer rather than a floor:
   * without one the pool only ever leaks, and nothing is released at all. {@link procPool} has
   * the steady state, and why this depends on your cast rate.
   */
  ailmentHit: number;
  /**
   * The longest-lived effect one press puts on **you**, and how long it lasts.
   *
   * Undefined for a spell that buffs nobody. Set even when the skill also deals damage, because
   * "how long does my buff last" is a question about the button and not about whether the button
   * is also a rotation step — {@link simulateFullDps} is what decides the second question.
   *
   * `durationSeconds` is `potion_dur` **after** `eff_dur_u_cast` and its twelve typed twins have
   * had their say; `declaredSeconds` is what the pack's JSON says. The pair is carried rather
   * than the resolved figure alone so a UI can show what the Effect Duration support gem bought,
   * which is the whole reason that gem is worth linking to a buff. See `effect-duration.ts`.
   */
  buff?: BuffDuration;
  /**
   * The longest-lived effect one press puts on the **enemy**, and how long it lasts.
   *
   * The mirror of {@link buff}, and it answers the same question for the half of the pack that
   * is pressed for what it does to the target rather than to you: a curse, a shred, a banner.
   * `cooldown_ticks` says how soon a curse *may* be re-cast and `potion_dur` says how soon it
   * *has to* be, and those differ by a factor of three on `curse_of_damnation`.
   *
   * Undefined for a spell that puts nothing on the target, which is most of them.
   */
  debuff?: BuffDuration;
  /** Exile effects this cast needs before it will do anything, from `caster_has_mns_effect`. */
  requires: string[];
  /**
   * What this cast costs you in health, when it declares a `self` damage act.
   *
   * Undefined for the 421 spells that do not. Never part of `dps` — see {@link SelfDamage}.
   */
  selfDamage?: SelfDamage;
  diagnostics: Diagnostic[];
};

/**
 * What sustained casting piles up, and how long it takes to pile up.
 *
 * `dps` is a steady-state figure and already accounts for overlap: a cast delivers its whole
 * output eventually, so casting every `T` seconds averages to `damagePerCast / T` no matter how
 * long each cast takes to finish delivering. What the steady-state number cannot tell you is
 * that it is not true yet at second one — and against a boss you reach it, while against a pack
 * that dies in a second you never do.
 */
export type Overlap = {
  /** The most casts of this skill dealing damage at the same time, across its sources. */
  concurrentCasts: number;
  /** Projectiles in the world at once, once sustained. 0 for a spell that throws none. */
  projectilesAlive: number;
  /**
   * Seconds of sustained casting before the full `dps` is being dealt — the longest-lived
   * source's duration. Before this, damage is still ramping.
   */
  rampSeconds: number;
  /** True when anything at all outlives the cast cycle. */
  overlapping: boolean;
};

/**
 * Why a skill is in the rotation: you press it for its damage, you press it to keep something
 * up, or you pressed it once at the start of the map and it has been running ever since.
 *
 * The distinction exists because charging one press per pass is wrong by a large factor and
 * always in the same direction. `banishing_blade` is a toggle — one press, `potion_dur: -1`,
 * and it is up for the rest of the fight — but it declares a 40-tick cooldown, and a rotation
 * that treated it as a step both added its cast to every pass *and* stretched the pass to its
 * cooldown. Ticking one free toggle next to a 1.0s skill more than halved the reported DPS,
 * which is the opposite of what putting a buff on the bar does.
 *
 * The same is true of everything you press for a *duration* rather than for a hit.
 * `curse_of_damnation` leaves `damnation` on the pack for ten seconds and comes off cooldown
 * after three; nobody re-curses three times over, so its period is the debuff's and not the
 * button's.
 */
export type FullDpsRole =
  /** Pressed once per pass, for what it does to the target. */
  | "rotation"
  /**
   * Pressed when what it applied runs out — a buff on you, a curse on the pack.
   *
   * Rarely, and for a `potion_dur: -1` toggle never.
   */
  | "upkeep"
  /**
   * A toggle that deals damage while it is up: the pack's four damaging auras.
   *
   * Free like any other toggle — one press a map, no cooldown the pass waits on — but unlike a
   * buff it is *also* a damage source, and one that runs on its own timing. Holy Fire pulses
   * every 10 ticks whatever you are doing with your hands, so its contribution is added to the
   * rotation as a rate rather than as damage per press.
   */
  | "aura";

export type FullDpsSkill = {
  skill: SkillSetup;
  result: DpsResult;
  /**
   * Seconds this skill takes out of one pass through the rotation.
   *
   * For a rotation step that is one press. For an upkeep buff it is one press amortised over
   * how often the press comes round, so a toggle costs the pass nothing at all.
   */
  rotationSeconds: number;
  role: FullDpsRole;
  /** What one press costs: its cast, plus the global cooldown it arms on everything else. */
  pressSeconds: number;
  /**
   * Upkeep only: seconds between presses. `Infinity` for a toggle you press once.
   *
   * `max(effect duration, the spell's own cycle)` — you re-press when it falls off, and no
   * faster than the cooldown lets you.
   */
  upkeepSeconds?: number;
  /** Which side the effect that set the period sits on: your sheet, or the pack's. */
  upkeepHolder?: "caster" | "target";
  /**
   * What this skill deals per second on a clock the rotation does not set.
   *
   * An aura's pulses. Added to the pass as a rate rather than as damage per press, and therefore
   * the one term here that does not change when you tick a second skill in beside it.
   */
  auraDps?: number;
  /**
   * Upkeep only: how long one press actually lasts, before the cooldown is considered.
   *
   * Below {@link upkeepSeconds} exactly when the spell's own cooldown outlasts its effect, which
   * is the one case where a buff genuinely has downtime — `quickdraw` is 8s of buff behind a 20s
   * cooldown. The figures here assume it is up throughout and a diagnostic says so.
   */
  upkeepDurationSeconds?: number;
  /** Upkeep only: presses in one pass — `rotationSeconds / upkeepSeconds`. 0 for a toggle. */
  pressesPerRotation?: number;
  /** Upkeep only: the effect whose duration set the period. */
  upkeepEffectId?: string;
};

export type FullDpsResult = {
  skills: FullDpsSkill[];
  /** Seconds for one pass through every ticked skill, global cooldowns included. */
  rotationSeconds: number;
  /**
   * Damage one pass puts on the target, from the casts themselves.
   *
   * Aura pulses are deliberately not in it: they are not produced by a press, so there is no
   * "per pass" figure for them that a longer pass would not inflate. They are in
   * {@link auraDps} and in {@link skillDps}.
   */
  damagePerRotation: number;
  /**
   * What the auras you are running deal per second, on their own fixed timing.
   *
   * Part of {@link skillDps}, and the one term of it a rotation's length does not move: Holy
   * Fire pulses twice a second whether you are pressing one button or four.
   */
  auraDps: number;
  /** `damagePerRotation / rotationSeconds + auraDps` — the casts alone, without what they set off. */
  skillDps: number;
  /**
   * Every proc the whole rotation fires, merged across the skills that trigger it.
   *
   * Not the sum of the per-skill lists: `proc_cooldown_ticks` is one ceiling over the build, so
   * two skills procing the same spell share it. {@link rotationProcs} does the merge.
   */
  procs: Proc[];
  /** `sum(procs.dps)`. Part of {@link dps}, unlike the single-skill figure's. */
  procDps: number;
  /**
   * `skillDps + procDps` — what the rotation puts on the target per second.
   *
   * Procs are in it because a proc is not a second build you opted into: it is what the gear you
   * are already wearing does while you press the buttons you already press. Leaving them out
   * made a proc-heavy build read as a weak one.
   */
  dps: number;
  /**
   * The casts' all-crit branch, for comparison against {@link skillDps}.
   *
   * Procs are deliberately not added: `damagePerProc` is already the crit-weighted average of
   * the procced spell, so there is no all-crit figure to add and folding the average one in
   * would make this neither branch.
   */
  critDps: number;
  packDps: number;
  ailmentDps: number;
  /** The Shatter and Shock share of {@link ailmentDps}, summed over the rotation. Inside it. */
  ailmentProcDps: number;
  diagnostics: Diagnostic[];
};

// ---------------------------------------------------------------------------
// One skill
// ---------------------------------------------------------------------------

export function simulateDps(
  build: BuildDoc,
  snapshot: Snapshot,
  options: DpsOptions = {},
): DpsResult | undefined {
  // A disabled skill keeps its support gems and its place in the list and contributes nothing,
  // so it is never what a document meant by "the main skill" — but an explicit `options.skill`
  // still wins, because a caller asking for one by name has already decided.
  const live = (build.skills ?? []).filter(isSkillEnabled);
  const stated = options.skill ?? live.find((s) => s.main);
  // With none stated, the first skill that can actually hit something. Taking `live[0]` outright
  // is how a capture whose bar begins with Protection reported 0 DPS for a build with Quake on
  // it — and that zero propagated: every what-if figure in the planner is a difference between
  // two DPS numbers, so a main skill that deals no damage made the tree hover, the gem ranking
  // and the Damage tab all read "nothing changes" whatever you did.
  const chosen =
    stated ??
    live.find((s) => {
      const data = snapshot.registries["mmorpg_spells"]?.[s.spellId]?.data;
      return data !== undefined && declaresDamage(data);
    }) ??
    live[0];
  if (!chosen) return undefined;

  const spellEntry = snapshot.registries["mmorpg_spells"]?.[chosen.spellId]?.data;
  if (!spellEntry) return undefined;

  const diagnostics: Diagnostic[] = [];
  const spell = spellEntry;

  const bal = balance(snapshot, options.balanceId);
  const index = statIndex(snapshot);
  const layers = layerIndex(snapshot);
  const compat = options.compat ?? ORIGINAL_MODE;

  // Computed once and handed to every source. Two `calculate` passes for the whole spell
  // rather than two per damage act.
  const pickOptions = {
    ...(options.balanceId === undefined ? {} : { balanceId: options.balanceId }),
    ...(options.baseStatsId === undefined ? {} : { baseStatsId: options.baseStatsId }),
  };
  // Resolved once and handed to everything downstream — both stat sheets, the rate sweep, every
  // damage event and the source walk — so all of them describe the same character. Which effects
  // are up decides which branch of a spell exists *and* what the sheet underneath it reads, so
  // nothing below can be computed before it.
  //
  // `resolveEffects` returns the character sheet it settled on, rather than a state to go and
  // build one with: asking twice is how the two came apart in the first place. The spell's own
  // gates break an exclusivity tie — if you have two auras and this spell has a branch for one of
  // them, that is the branch the figure should be about.
  const opening: EngineResult =
    options.characterRun ?? resolveEffects(build, snapshot, pickOptions, gatedEffectIds(spell));

  // The rotation, before the character it describes. A combo *resource* — an effect this skill
  // both gates on and spends — is up because the previous press handed it over, not because the
  // build could produce it, and the two answers differ: `phase_dive`'s eight branches over
  // `alpha`/`beta`/`gamma` gave the engine the all-three branch for free while the chain pricing
  // it pressed three buttons and arrived holding one, so the rate described one rotation and the
  // damage another.
  //
  // `planCombo` reads spell data alone, bar the basic-attack starter, which is why it can run on
  // the opening sheet and hand its answer back to a second resolution. The second pass is skipped
  // whenever it could not change anything — a skill that spends no resource, or a caller that
  // brought its own sheet — so the ordinary spell still costs exactly one settle.
  const plan = planCombo(snapshot, build, chosen.spellId, opening.stats);
  const characterRun: EngineResult =
    plan.resources.length === 0 || options.characterRun !== undefined
      ? opening
      : resolveEffects(build, snapshot, pickOptions, gatedEffectIds(spell), {
          resources: plan.resources,
          holds: plan.holds,
        });
  const effects = characterRun.effects;

  // `EntityData.calcStats` builds the character unit and then hands it to `calcSpellLevels`, so
  // the ranks are only knowable here — after the sheet and before any spell unit. An unstated
  // level therefore means the class allocation *plus* whatever `+N to Spells` the build carries,
  // which is what the game would have put on the bar.
  const ranks = spellRanks(snapshot, characterRun.stats, bal);
  const skill = withLearnedRank(snapshot, build, chosen, ranks);

  const sheetOptions = { ...pickOptions, effects, spellRanks: ranks };
  const spellRun: EngineResult = calculate(build, snapshot, { ...sheetOptions, skill });
  diagnostics.push(...spellRun.diagnostics);
  const sheets = { character: characterRun, spell: spellRun };

  const declared = spellConfig(spell);

  const calc = calculateSpell({
    equipped: build.skills ?? [],
    snapshot,
    index,
    layers,
    balance: bal,
    // The spell unit, not the character sheet: a support gem's cooldown reduction has to reach
    // this, and it only exists on the spell's own unit.
    sheet: spellRun.stats,
    spell,
    skill,
    characterLevel: build.character.level,
    config: build.config ?? {},
    compat,
    effects,
    diagnostics,
  });

  const rate = rateOf(calc, declared);

  // A spell with no cast speed is not a button. `rateOf` paces it by `proc_cooldown_ticks`
  // rather than by the one-tick floor that used to make `cursed_raging_dragon` report 27
  // million, but that is a ceiling and nothing about the build supports it — so say whose
  // trigger it is waiting on, and whether this build has one.
  if (!rate.castable) {
    const sources = procSourcesFor(snapshot, skill.spellId, characterRun.stats);
    const held = sources.filter((s) => s.onSheet);
    diagnostics.push({
      severity: held.length > 0 ? "info" : "warning",
      code: "spell-not-castable",
      path: "skills",
      message:
        `\`${skill.spellId}\` declares \`cast_speed_ticks: 0\`, so it cannot be cast — it happens ` +
        `when something triggers it. ` +
        (sources.length === 0
          ? `Nothing in the pack procs it, so this figure describes a cast that never occurs.`
          : held.length === 0
            ? `${sources.length} stat(s) proc it (${sources.slice(0, 3).map((s) => `\`${s.statId}\``).join(", ")}` +
              `${sources.length > 3 ? ", …" : ""}) and this build carries none of them, so nothing here produces it.`
            : `${held.map((s) => `\`${s.statId}\``).join(", ")} procs it on this build — its real rate is on ` +
              `whichever skill you are actually casting, under Procs.`) +
        (rate.procPaced
          ? ` The cycle shown is \`proc_cooldown_ticks\` — the fastest it could ever repeat, not a rate you can plan on.`
          : ` The cycle shown is its own cooldown, which caps how often a trigger can land it.`),
    });
  }

  const walked = skillModel(
    spell,
    declared,
    calc,
    effects,
    options.entryGroup ?? "on_cast",
    build.config?.conditions,
  );

  // An aura's damage is not reachable from its own button — the branch that would grant the
  // effect is gated on *not* already having it, so on a build that runs the aura that branch is
  // correctly blocked. `auras.ts` enters from the effect the character is holding instead, and
  // what it finds is appended here because it is damage this skill is responsible for and
  // belongs in this skill's figure, not in a second one beside it.
  const auras = auraSources({
    snapshot,
    effects,
    spellId: skill.spellId,
    spell,
    declared,
    calc,
    cycleTicks: rate.cycleSeconds * TICKS_PER_SECOND,
    conditions: build.config?.conditions,
  });
  const model: SkillModel =
    auras.sources.length === 0
      ? walked
      : { ...walked, sources: [...walked.sources, ...auras.sources] };

  for (const id of auras.gaps) {
    diagnostics.push({
      severity: "info",
      code: "enemy-effect-damage-unmodelled",
      path: "skills",
      message:
        `\`${skill.spellId}\` puts \`${id}\` on the enemy, and that effect damages whoever holds ` +
        `it — the mob. Pricing it needs the mob's own sheet to tick against, which is stated ` +
        `rather than derived, so it is listed and not counted.`,
    });
  }

  const placement = options.placement ?? build.config?.target ?? DEFAULT_PLACEMENT;
  const packSize = Math.max(1, options.packSize ?? build.config?.packSize ?? 1);

  if (model.sources.length === 0) {
    diagnostics.push({
      severity: "warning",
      code: "no-damage-action",
      path: "skills",
      message:
        `\`${skill.spellId}\` declares no reachable \`damage\` act, so it deals no direct damage. ` +
        `Its output is entirely procs, ailments or summons, none of which this figure covers.`,
    });
  }
  for (const group of model.unreachableGroups) {
    diagnostics.push({
      severity: "info",
      code: "unreachable-component-group",
      path: "skills",
      message:
        `\`${skill.spellId}\` declares the component group \`${group}\` but nothing spawns or ` +
        `invokes it, so anything it would have done is not counted.`,
    });
  }
  if (model.unmodelledSummons.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "summon-output-unmodelled",
      path: "skills",
      message:
        `\`${skill.spellId}\` puts a vanilla entity in the world (\`${model.unmodelledSummons.join("`, `")}\`) ` +
        `whose damage is Minecraft's rather than this pack's, so it is on no stat sheet and is not ` +
        `in this figure. Mine and Slash's own pets are counted — see the summons beside the figure.`,
    });
  }
  for (const act of model.unmodelledActs) {
    diagnostics.push({
      severity: "info",
      code: "unmodelled-act",
      path: "skills",
      message: `\`${skill.spellId}\` uses the \`${act}\` act, which this model does not interpret.`,
    });
  }

  // Read from the document as well as the options, exactly as `placement` and `packSize` are
  // above. The Damage tab's per-source field writes `config.coverageOverrides` and nothing
  // else, so an engine that only read `options` ignored every number typed into it.
  const overrides = options.coverageOverrides ?? build.config?.coverageOverrides ?? {};
  const sources: SourceResult[] = [];
  const requires = new Set<string>();
  // Collected from the first source's sweep only: every source of a spell sweeps the same
  // source-side stats, so asking each one would report the same procs six times over.
  const wantProcs = options.procs !== false;
  let procHits: { onHit: ProcHit[]; onCrit: ProcHit[] } | undefined;
  let critChance = 0;

  for (const source of model.sources) {
    for (const need of source.requires) {
      if (!need.negated) requires.add(need.effectId);
    }

    const hit = simulateHit(build, snapshot, {
      ...options,
      // `skill`, not `chosen`: the rank `withLearnedRank` resolved is what every value
      // calculation reads, and handing the raw setup over here dropped it. It only showed on a
      // skill whose rank the document does not state — a procced one — where the level fell
      // back to `default_lvl` and every `LeveledValue` on the spell read its minimum.
      skill,
      sheets,
      effects,
      // Never off a self-hit: `disable_attacker_stats` means its source sweep does not run, so it
      // reaches no `proc_spell` block and would report an empty list as though it were an answer.
      procs: wantProcs && procHits === undefined && source.target?.kind !== "self",
      element: source.element,
      valueCalcId: source.valueCalcId,
      // A `self` selector is the caster. Resolved against your own sheet rather than the mob's,
      // it is the cost of the cast; resolved against the mob's it is a number about nothing.
      selfHit: source.target?.kind === "self",
    });
    if (!hit) continue;
    if (hit.procs !== undefined) {
      procHits = hit.procs;
      critChance = hit.critChance;
    }

    const forced = overrides[source.id];
    const coverage: Coverage =
      forced === undefined
        ? coverageOf(source, placement)
        : {
            hitsPerCast: Math.max(0, forced),
            fraction: source.instancesPerCast > 0 ? Math.max(0, forced) / source.instancesPerCast : 0,
            method: "assumed",
            // The schedule the simulation would have produced is kept even when the count is
            // overridden: an override says *how many* land, not *when* — and the ramp needs
            // the when. Falling back to a single hit at the cast would claim a burst.
            landedTicks: coverageOf(source, placement).landedTicks,
            note: "set by the build document",
          };

    const durationSeconds = lastLandingTick(coverage, source) / TICKS_PER_SECOND;

    // What a summon limit does to the pace. Everything else is `undefined` and costs nothing.
    const limit = sustainLimit(source, rate.cycleSeconds);

    // An instant source still has one cast's worth of it happening when it happens; 0 is
    // reserved for a source that puts nothing on the target at all.
    const overlapRatio = rate.cycleSeconds > 0 ? durationSeconds / rate.cycleSeconds : 1;
    const uncapped = coverage.hitsPerCast > 0 ? Math.max(1, overlapRatio) : 0;
    // A group never has more than `maxAlive` members on the field, however fast you press.
    const concurrentCasts =
      limit === undefined ? uncapped : Math.min(uncapped, limit.maxAlive);
    sources.push({
      source,
      hit,
      coverage,
      damagePerCast: hit.average.total * coverage.hitsPerCast,
      critDamagePerCast: hit.crit.total * coverage.hitsPerCast,
      persistent: durationSeconds > rate.cycleSeconds,
      sustained: limit === undefined ? 1 : rate.cycleSeconds / limit.periodSeconds,
      ...(limit === undefined ? {} : { limit }),
      durationSeconds,
      concurrentCasts,
      concurrentCarriers: concurrentCasts * source.carriersPerCast,
    });

    if (limit !== undefined) {
      diagnostics.push({
        severity: "info",
        code: "summon-limit-paces-source",
        path: "skills",
        message:
          `\`${skill.spellId}\` source \`${source.id}\` is in the \`${limit.group}\` summon ` +
          `limit group, so at most ${limit.maxAlive} of them exist at once — every cast culls ` +
          `the oldest. Placing one every ${rate.cycleSeconds.toFixed(2)}s would destroy it before ` +
          `it finished, so this source is paced at one per ${limit.periodSeconds.toFixed(2)}s ` +
          `instead and contributes ${(100 * (rate.cycleSeconds / limit.periodSeconds)).toFixed(0)}% ` +
          `of what the button rate alone would claim. ` +
          `\`max_${limit.group}s\` raises the ceiling.`,
      });
    }

    if (coverage.method === "assumed" && forced === undefined) {
      diagnostics.push({
        severity: "warning",
        code: "coverage-assumed",
        path: "skills",
        message:
          `\`${skill.spellId}\` source \`${source.id}\`: ${coverage.note ?? "coverage could not be derived"}.`,
      });
    }
  }

  const damagePerCast = sources.reduce((sum, s) => sum + s.damagePerCast, 0);
  const critDamagePerCast = sources.reduce((sum, s) => sum + s.critDamagePerCast, 0);
  // What the *rate* is allowed to divide, which is not the same total: a source a summon limit
  // paces contributes only its sustained share, because the casts in between throw their own
  // carriers away. `damagePerCast` above stays the honest answer to "what does one cast put out",
  // which is what a single press into an empty field really delivers.
  const sustainedPerCast = sources.reduce((sum, s) => sum + s.damagePerCast * s.sustained, 0);
  const sustainedCritPerCast = sources.reduce(
    (sum, s) => sum + s.critDamagePerCast * s.sustained,
    0,
  );
  const persistentPerCast = sources
    .filter((s) => s.persistent)
    .reduce((sum, s) => sum + s.damagePerCast * s.sustained, 0);
  // What a permanent aura contributed, kept separately for the one caller that must not pace it
  // by this skill's cycle. See `DpsResult.auraDamagePerCast`.
  const auraSourceResults = sources.filter(
    (s) => s.source.carrier.kind === "effect" && s.source.carrier.permanent,
  );
  const auraPerCast = auraSourceResults.reduce((sum, s) => sum + s.damagePerCast * s.sustained, 0);
  const auraCritPerCast = auraSourceResults.reduce(
    (sum, s) => sum + s.critDamagePerCast * s.sustained,
    0,
  );

  const perSecond = (total: number): number =>
    rate.cycleSeconds > 0 ? (total * rate.castsPerCycle) / rate.cycleSeconds : 0;

  // What pressing this button does to you. Separate from everything above because it is the only
  // number here that is not about the target — and it is a cost rather than a hit, so it is not
  // netted off the DPS and never will be.
  const selfSources = sources.filter((s) => s.source.target?.kind === "self");
  const selfDamage: SelfDamage | undefined =
    selfSources.length === 0
      ? undefined
      : (() => {
          // `instancesPerCast`, not `coverage.hitsPerCast`: coverage answers "how much of this
          // reaches the enemy", which for a `self` selector is zero by construction. How many
          // times it hits *you* is how many times the act runs.
          const perCast = selfSources.reduce(
            (sum, s) => sum + s.hit.average.total * s.source.instancesPerCast,
            0,
          );
          const rawPerCast = selfSources.reduce(
            (sum, s) => sum + s.hit.baseValue * s.source.instancesPerCast,
            0,
          );
          const cutoff = auraCutoffShare(snapshot, auras.effectIds);
          return {
            sources: selfSources,
            perCast,
            rawPerCast,
            perSecond: perSecond(perCast),
            mitigated: rawPerCast > 0 ? 1 - perCast / rawPerCast : 0,
            ...(cutoff === undefined ? {} : { cutoffShare: cutoff }),
          };
        })();

  // What it costs to be allowed to press this at all. Resolved here rather than inside the rate
  // because it is a property of the *bar*, not of the spell: the same finisher on a bar with no
  // extender on it has no chain, and says so.
  const combo = resolveCombo({
    snapshot,
    build,
    index,
    layers,
    balance: bal,
    compat,
    effects,
    skill,
    engineOptions: pickOptions,
    sheet: characterRun.stats,
    plan,
  });
  const comboDps =
    combo?.secondsPerCast !== undefined && combo.secondsPerCast > 0
      ? (sustainedPerCast * rate.castsPerCycle) / combo.secondsPerCast
      : undefined;

  if (combo !== undefined) {
    for (const link of combo.broken) {
      diagnostics.push({
        severity: "warning",
        code: "combo-chain-broken",
        path: "skills",
        message: link.note,
      });
    }
    if (combo.secondsPerCast === undefined && combo.broken.length === 0) {
      diagnostics.push({
        severity: "info",
        code: "combo-chain-untimed",
        path: "skills",
        message:
          `\`${skill.spellId}\` needs ${combo.steps.length - 1} other press(es) before it fires, and ` +
          `one of them could not be timed — so the chain shows the presses without a rate. ` +
          `${combo.steps.find((st) => st.seconds === undefined)?.note ?? ""}`.trim(),
      });
    } else if (combo.secondsPerCast !== undefined) {
      diagnostics.push({
        severity: "info",
        code: "combo-chain-paced",
        path: "skills",
        message:
          `\`${skill.spellId}\` fires once per ${combo.secondsPerCast.toFixed(2)}s of combo, not once ` +
          `per ${rate.cycleSeconds.toFixed(2)}s: ` +
          // A self-toggle's chain is the same button twice, and printing that as "it spends
          // hoarfrost_armor → hoarfrost_armor" reads as a mistake rather than as a mechanic.
          (combo.steps.every((st) => st.spellId === skill.spellId)
            ? `one press arms it and the next spends it, so the gated half lands every other press`
            : `it spends ${combo.steps.map((st) => st.spellId ?? "a basic attack").join(" → ")}`) +
          `. \`dps\` is the button rate; \`comboDps\` is the chain rate.`,
      });
    }
  }

  const character = characterRun.stats;
  const castsPerSecond = rate.cycleSeconds > 0 ? rate.castsPerCycle / rate.cycleSeconds : 0;
  // The whole tick, not the flat stat: `<r>_per_sec` scales with the pool and the
  // `on_restore_resource` percents multiply both. And with the Blood Magic game changer on, the
  // mana cost is paid from blood, which regenerates from something else entirely.
  const regen = resources(build, snapshot, { ...pickOptions, sheet: characterRun });
  const manaSpentAs = resourceSpent(character, "mana");
  const energySpentAs = resourceSpent(character, "energy");
  // The in-combat column, because a rotation is in combat by definition: `in_combat` is a
  // ten-second cooldown that every hit you land or take re-stamps.
  const perSecondOf = (id: ResourceId): number =>
    regen.byResource.find((r) => r.resource === id)?.inCombatPerSecond ?? 0;
  const manaRegen = perSecondOf(manaSpentAs);
  const energyRegen = perSecondOf(energySpentAs);
  const manaPerSecond = calc.manaCost * castsPerSecond;
  const energyPerSecond = calc.energyCost * castsPerSecond;

  // Leech comes off the sweep the damage already ran, so every gate a hit answered — which
  // element it was, whether the target dodged, whether it was a basic attack — is folded in
  // without asking any of it twice. `hitsPerCast` scales each source's records the same way it
  // scales that source's damage, and `average` has already weighted the crit branch.
  const perSecondRestores: RestoreRecord[] = [];
  for (const entry of sources) {
    for (const record of entry.hit.average.restores) {
      perSecondRestores.push({
        ...record,
        amount: record.amount * entry.coverage.hitsPerCast * castsPerSecond,
      });
    }
  }
  const leeched = leech({
    build,
    snapshot,
    perSecond: perSecondRestores,
    options: { ...pickOptions, sheet: characterRun },
  });
  diagnostics.push(...leeched.diagnostics);
  // `resources` answers which pool pays and what fills it, and a blood mage most needs to be told
  // that before reading a sustain verdict. Its diagnostics were computed and dropped on the floor.
  diagnostics.push(...regen.diagnostics);

  // With Blood Magic on, `BloodUserEffect` redirects mana *and* energy, so both costs land on
  // blood and have to be added rather than written into the same key twice — a map literal would
  // have kept only the second and silently forgiven whichever cost came first.
  const perCast = new Map<ResourceId, number>();
  const bill = (resource: ResourceId, amount: number): void => {
    perCast.set(resource, (perCast.get(resource) ?? 0) + amount);
  };
  bill(manaSpentAs, calc.manaCost);
  bill(energySpentAs, calc.energyCost);
  const books = budget({ regen, leech: leeched, perCast, castsPerSecond });
  const starved = books.filter((row) => !row.sustainable);
  for (const row of starved) {
    // A ceiling below one cast is a different failure from a rate that does not keep up, and
    // saying "runs out after N seconds" about a pool that was never able to pay once would send
    // you looking for regeneration that cannot help.
    if (!row.holdsACast) {
      diagnostics.push({
        severity: "warning",
        code: "resource-pool-too-small",
        path: "skills",
        message:
          `${row.resource} cannot pay for a single cast: the pool caps at ${row.max.toFixed(0)} ` +
          `and one cast costs ${row.costPerCast.toFixed(1)}. A pool never fills past its maximum, ` +
          `so the ${row.regenPerSecond.toFixed(1)}/s regenerating into it changes nothing` +
          (regen.bloodMage && (row.resource === "mana" || row.resource === "energy")
            ? ` — and with \`blood_user\` on, this pool is not what pays anyway.`
            : `.`),
      });
      continue;
    }
    diagnostics.push({
      severity: "warning",
      code: "resource-not-sustainable",
      path: "skills",
      message:
        `${row.resource} runs out: ${row.costPerSecond.toFixed(1)}/s spent against ` +
        `${row.regenPerSecond.toFixed(1)}/s regenerated` +
        (row.leechPerSecond > 0 ? ` and ${row.leechPerSecond.toFixed(1)}/s leeched` : "") +
        `. A full pool of ${row.max.toFixed(0)} lasts ` +
        `${(row.secondsToEmpty ?? 0).toFixed(1)}s` +
        (row.castsBeforeEmpty === undefined
          ? ""
          : ` — about ${Math.floor(row.castsBeforeEmpty)} casts`) +
        `, after which this figure is the burst rate rather than the sustained one.`,
    });
  }
  for (const entry of leeched.unrated) {
    diagnostics.push({
      severity: "info",
      code: "leech-not-rated",
      path: "tree",
      message:
        `\`${entry.statId}\` (${entry.value.toFixed(1)}) ${entry.reason}, so it is not in the ` +
        `sustain figures. It is real sustain; it is simply not a rate this document states.`,
    });
  }

  // The biggest single source, so `DpsResult.hit` still means something on its own.
  //
  // Self-targeted acts are excluded first. Eleven spells carry `allow_self_damage: true` — the
  // recoil on `forbidden_rite`, the cost of `eighth_gate` — and their damage act resolves against
  // a `self` selector, so it lands on nothing the enemy can feel. It already contributes 0 to
  // `damagePerCast`; without this it could still become the headline on a spell whose *only*
  // damage act is the recoil, and the ailments computed off it would be reported as ailments on
  // the mob.
  const landing = sources.filter(
    (s) => s.source.target?.kind !== "self" && s.coverage.hitsPerCast > 0,
  );
  const headline = (landing.length > 0 ? landing : sources).reduce<SourceResult | undefined>(
    (best, s) => (best === undefined || s.damagePerCast > best.damagePerCast ? s : best),
    undefined,
  );
  /** Whether the headline is a hit the enemy actually takes, which is what ailments ride on. */
  const headlineLands = headline !== undefined && landing.includes(headline);
  const hit = headline?.hit ?? simulateHit(build, snapshot, { ...options, skill, sheets, effects });
  if (!hit) return undefined;

  // The projectile the headline should be about is the one carrying the damage, not the first
  // one the walk happened to reach. `raging_dragon` throws a `combo_remover` first — a 1-tick
  // marker with `ignore_bonus_proj: true` that deals nothing — and reporting its count of 1
  // hides the nine dragons behind it. Falling back to the widest carrier keeps a spell whose
  // projectile carries no damage of its own from reporting none at all.
  const headlineProjectile = projectileOf(headline?.source.carrier) ?? widestProjectile(model);
  const multiHit: MultiHitInfo = {
    baseProjectiles: headlineProjectile?.baseCount ?? 0,
    bonusProjectiles: calc.bonusProjectiles,
    projectiles: headlineProjectile?.count ?? 0,
    chains: declared.chainCount + calc.bonusChains,
    pierce: calc.pierce,
    nova: calc.nova,
    barrage: calc.barrage,
  };

  for (const blocked of model.blockedBy) {
    const { kind, effectId, negated, minimumStacks } = blocked.requirement;

    // A potion gate is not a `config.effects` question and there is nothing to turn on in the
    // effect list, so it gets its own line. The common case is the *useful* one: a branch that
    // fires only while you are invisible is correctly absent, and saying so is what stops the
    // reader wondering whether the other half of `execute` is missing.
    if (kind === "potion") {
      const key = potionConditionKey(effectId);
      diagnostics.push({
        severity: "info",
        code: "branch-gated-on-potion",
        path: `config.conditions.${key}`,
        message:
          `\`${skill.spellId}\` has a branch behind ${negated ? "not having" : "having"} ` +
          `\`${effectId}\` — ${blocked.damageActs} damage act(s). A vanilla potion effect is ` +
          `world state, not a property of the build, so it is assumed absent. Set ` +
          `\`config.conditions.${key}\` to true to count it instead.`,
      });
      continue;
    }

    const want = negated
      ? `not having \`${effectId}\``
      : `\`${effectId}\`${minimumStacks > 1 ? ` ×${minimumStacks}` : ""}`;
    diagnostics.push({
      severity: "info",
      code: "branch-gated-off",
      path: "config.effects",
      message:
        `\`${skill.spellId}\` has a branch behind ${want} — ${blocked.damageActs} damage act(s) ` +
        `— and ${blocked.activeStacks === 0 ? "it is not up" : `only ${blocked.activeStacks} stack(s) are up`}. ` +
        (effects.assume === "captured"
          ? `Your capture did not record it, so it is off; turn it on in \`config.effects\` to count the branch.`
          : `Nothing in the build applies it, or \`config.effects\` turned it off.`),
    });
  }

  if (requires.size > 0) {
    diagnostics.push({
      severity: "info",
      code: "cast-requires-effect",
      path: "skills",
      message:
        `\`${skill.spellId}\` does nothing without ${[...requires].map((e) => `\`${e}\``).join(", ")}. ` +
        `This figure assumes the effect is up; tick the skill that applies it into Full DPS to ` +
        `pay for the cast that puts it there.`,
    });
  }

  // A skill whose every source misses is the one case where the placement, not the build, is
  // what the number is about. Saying so — and saying where it does land — turns a bare zero into
  // a fact about the skill's reach. The sweep only runs on that path, and only over the model.
  const reachDistance =
    damagePerCast <= 0 && sources.length > 0 ? reachOf(sources, placement) : undefined;
  if (reachDistance !== undefined) {
    diagnostics.push({
      severity: "info",
      code: "placement-out-of-reach",
      path: "config.target",
      message:
        `\`${skill.spellId}\` reaches nothing with the target ${placement.distance} blocks away: ` +
        `it lands out to ${reachDistance.toFixed(1)} and no further. The figure is measured at a ` +
        `placement this skill's own area does not cover.`,
    });
  }

  // Hits per second across every source — the rate every on-hit proc triggers at. A proc on a
  // channel that lands ten pulses a second is a different stat from the same proc on a slam.
  const hitsPerSecond =
    rate.cycleSeconds > 0
      ? (sources.reduce((sum, s) => sum + s.coverage.hitsPerCast, 0) * rate.castsPerCycle) /
        rate.cycleSeconds
      : 0;

  const procs =
    procHits === undefined
      ? []
      : resolveProcs({
          snapshot,
          build,
          effects,
          onHit: procHits.onHit,
          onCrit: procHits.onCrit,
          critChance,
          hitsPerSecond,
          sheet: characterRun.stats,
          spellTags: new Set(declared.tags),
          // A skill switched off on the Skills tab is off everywhere, and a proc is the one
          // route by which a switched-off skill could still have reached a figure: the procced
          // spell is resolved by id, so the skill list's own `enabled` filter never sees it.
          disabledSpells: new Set(
            (build.skills ?? []).filter((s) => !isSkillEnabled(s)).map((s) => s.spellId),
          ),
          // The procced spell is resolved as its own cast, with its procs off so a chain cannot
          // recurse, and at the same placement — it lands where you are fighting.
          damageOf: (spellId) => {
            const entryData = snapshot.registries["mmorpg_spells"]?.[spellId]?.data;
            if (!entryData) return 0;
            const procSkill: SkillSetup = (build.skills ?? []).find((s) => s.spellId === spellId) ?? {
              spellId,
            };
            const result = simulateDps(build, snapshot, {
              ...options,
              skill: procSkill,
              procs: false,
              placement,
            });
            return result?.damagePerCast ?? 0;
          },
          diagnostics,
        });

  // A pet's swing is its own spell on vanilla's clock, so it is resolved the way a proc is: a
  // nested `simulateDps` of the basic attack, entered at the group the pet's hit actually drives
  // rather than at `on_cast`, with its own summons and procs off so nothing can recurse.
  const summons =
    options.summons === false
      ? []
      : resolveSummons({
          snapshot,
          spell,
          spellId: skill.spellId,
          calc,
          cycleSeconds: rate.cycleSeconds,
          damageOf: (basicSpellId) => {
            if (snapshot.registries["mmorpg_spells"]?.[basicSpellId]?.data === undefined) return 0;
            const petSkill: SkillSetup = (build.skills ?? []).find(
              (s) => s.spellId === basicSpellId,
            ) ?? { spellId: basicSpellId };
            const result = simulateDps(build, snapshot, {
              ...options,
              skill: petSkill,
              procs: false,
              summons: false,
              entryGroup: PET_ATTACK_GROUP,
              placement,
            });
            return result?.damagePerCast ?? 0;
          },
          // A pet's extra spell is cast *as you* from the pet's feet, so it is an ordinary cast
          // of that spell and resolves exactly like a proc does.
          damageOfCast: (castSpellId) => {
            if (snapshot.registries["mmorpg_spells"]?.[castSpellId]?.data === undefined) return 0;
            const castSkill: SkillSetup = (build.skills ?? []).find(
              (s) => s.spellId === castSpellId,
            ) ?? { spellId: castSpellId };
            const result = simulateDps(build, snapshot, {
              ...options,
              skill: castSkill,
              procs: false,
              summons: false,
              placement,
            });
            return result?.damagePerCast ?? 0;
          },
          golemSpellChance: characterRun.stats.get("golem_spell_chance")?.value ?? 0,
          diagnostics,
        });

  const rampSeconds = sources.reduce((max, entry) => Math.max(max, entry.durationSeconds), 0);
  const overlap: Overlap = {
    concurrentCasts: sources.reduce((max, entry) => Math.max(max, entry.concurrentCasts), 0),
    projectilesAlive: sources.reduce(
      (max, entry) =>
        entry.source.carrier.kind === "projectile" ? Math.max(max, entry.concurrentCarriers) : max,
      0,
    ),
    rampSeconds,
    overlapping: rampSeconds > rate.cycleSeconds,
  };

  // Zero when nothing this cast does lands on the enemy: a spell whose only damage act is its
  // own recoil inflicts no ailments, and reporting the recoil's would put several hundred DPS on
  // a pure buff. Hoisted because three figures below share the gate, and a gate applied to two
  // of three is the kind of thing nothing notices.
  const ailmentsLand = sources.length === 0 || headlineLands;

  // The spell sheet, deliberately: `ExileEffectAction` attaches the casting spell to the event,
  // so the duration is resolved off the per-spell unit and a linked Effect Duration gem reaches
  // it. See `effect-duration.ts`, which has the two lines of 6.4.13 that say so.
  const durationInput = {
    snapshot,
    index,
    layers,
    balance: bal,
    compat,
    sheet: spellRun.stats,
    spell,
    spellId: skill.spellId,
    spellTags: new Set(declared.tags),
    characterLevel: build.character.level,
    config: build.config ?? {},
    effects,
    diagnostics,
  };
  const buff = buffDurationOf(durationInput, "caster");
  // The same sweep on the target side. `increase_effect_duration_ticks_num` is a Source-side
  // stat — your own duration gear lengthens a curse you cast exactly as it lengthens a buff you
  // cast — so the only thing that changes is which grants are read.
  const debuff = buffDurationOf(durationInput, "target");

  return {
    spellId: skill.spellId,
    hit,
    ...(headline === undefined ? {} : { headlineSourceId: headline.source.id }),
    sources,
    overlap,
    model,
    declared,
    calc,
    rate,
    multiHit,
    cost: {
      manaPerCast: calc.manaCost,
      energyPerCast: calc.energyCost,
      manaPerSecond,
      energyPerSecond,
      manaRegen,
      energyRegen,
      leech: leeched,
      budget: books,
      manaSpentAs,
      energySpentAs,
      sustainable: starved.length === 0,
    },
    placement,
    effects,
    ...(reachDistance === undefined ? {} : { reachDistance }),
    damagePerCast,
    critDamagePerCast,
    auraDamagePerCast: auraPerCast,
    auraCritDamagePerCast: auraCritPerCast,
    auraDps: perSecond(auraPerCast),
    auraCritDps: perSecond(auraCritPerCast),
    dps: perSecond(sustainedPerCast),
    critDps: perSecond(sustainedCritPerCast),
    ...(combo === undefined ? {} : { combo }),
    ...(comboDps === undefined ? {} : { comboDps }),
    persistentDps: perSecond(persistentPerCast),
    procs,
    procDps: procDps(procs),
    summons,
    summonDps: summonDps(summons),
    packDps: perSecond(sustainedPerCast) * packSize,
    // Ailments are already a rate — they tick on their own clock, not the cast's — so they are
    // reported beside the hit rather than folded into it.
    ailmentDps: ailmentsLand
      ? hit.average.ailments.reduce(
          (sum, a) => sum + a.damagePerSecond + procPerSecond(a, castsPerSecond),
          0,
        )
      : 0,
    ailmentProcDps: ailmentsLand
      ? hit.average.ailments.reduce((sum, a) => sum + procPerSecond(a, castsPerSecond), 0)
      : 0,
    ailmentHit: ailmentsLand
      ? hit.average.ailments.reduce((sum, a) => sum + procPool(a, castsPerSecond), 0)
      : 0,
    ...(buff === undefined ? {} : { buff }),
    ...(debuff === undefined ? {} : { debuff }),
    requires: [...requires],
    ...(selfDamage === undefined ? {} : { selfDamage }),
    diagnostics: [...hit.diagnostics, ...diagnostics],
  };
}

/**
 * {@link BuffDuration} for one cast, or undefined when the press puts nothing on that side.
 *
 * `casterBuffUpkeep` and `targetDebuffUpkeep` pick the effect — the longest-lived of the ones
 * the press applies, which is the one whose expiry makes you press the button again — and this
 * resolves what the pack declared for it against the sheet that will actually be carrying it.
 *
 * Both sides read the same sweep because the stat that lengthens an effect is Source-side: your
 * duration gear extends a curse you put on a mob exactly as it extends a stance you put on
 * yourself. `holder` decides which grants are looked at and nothing else.
 */
function buffDurationOf(
  input: {
    snapshot: Snapshot;
    index: StatIndex;
    layers: LayerIndex;
    balance: Balance;
    compat: Compat;
    sheet: Sheet;
    spell: Record<string, unknown>;
    spellId: string;
    spellTags: ReadonlySet<string>;
    characterLevel: number;
    config: BuildConfig;
    effects: EffectState;
    diagnostics: Diagnostic[];
  },
  holder: "caster" | "target",
): BuffDuration | undefined {
  const upkeep =
    holder === "caster" ? casterBuffUpkeep(input.spell) : targetDebuffUpkeep(input.spell);
  if (upkeep === undefined) return undefined;

  if (!Number.isFinite(upkeep.durationTicks)) {
    return {
      effectId: upkeep.effectId,
      durationSeconds: Number.POSITIVE_INFINITY,
      declaredSeconds: Number.POSITIVE_INFINITY,
      infinite: true,
    };
  }

  const ticks = effectDurationTicks({
    snapshot: input.snapshot,
    index: input.index,
    layers: input.layers,
    balance: input.balance,
    compat: input.compat,
    sheet: input.sheet,
    effectId: upkeep.effectId,
    baseTicks: upkeep.durationTicks,
    spellId: input.spellId,
    spellTags: input.spellTags,
    characterLevel: input.characterLevel,
    config: input.config,
    effects: input.effects,
    diagnostics: input.diagnostics,
  });

  return {
    effectId: upkeep.effectId,
    durationSeconds: ticks / TICKS_PER_SECOND,
    declaredSeconds: upkeep.durationTicks / TICKS_PER_SECOND,
    infinite: false,
  };
}

/** How finely, and how far out, `reachOf` looks for a distance this skill does land at. */
const REACH_STEP = 0.1;
const REACH_LIMIT = 24;

/**
 * The farthest distance any of this skill's sources still lands at, or undefined if none ever do.
 *
 * Every other part of `placement` is held fixed: the question is only "how far away", because
 * that is the one part a player changes by walking.
 */
function reachOf(sources: SourceResult[], placement: TargetPlacement): number | undefined {
  let reach: number | undefined;
  for (let step = 0; step * REACH_STEP <= REACH_LIMIT; step++) {
    const distance = step * REACH_STEP;
    const lands = sources.some(
      (entry) => coverageOf(entry.source, { ...placement, distance }).hitsPerCast > 0,
    );
    if (lands) reach = distance;
  }
  return reach;
}

type ProjectileCarrier = Extract<Carrier, { kind: "projectile" }>;

function projectileOf(carrier: Carrier | undefined): ProjectileCarrier | undefined {
  return carrier?.kind === "projectile" ? carrier : undefined;
}

/**
 * The projectile carrier that throws the most, for a spell whose damage rides none of them.
 *
 * Ties go to the first, and a carrier that opted out of bonus projectiles loses to one that did
 * not — which is the whole point, since the marker projectiles are exactly the ones that opt out.
 */
function widestProjectile(model: SkillModel): ProjectileCarrier | undefined {
  let best: ProjectileCarrier | undefined;
  for (const carrier of model.carriers) {
    const projectile = projectileOf(carrier);
    if (projectile === undefined) continue;
    if (best === undefined || projectile.count > best.count) best = projectile;
  }
  return best;
}

/**
 * What a `BlockSummonLimitGroup` does to how often a source can really be delivered.
 *
 * `enforceSummonLimit` culls the oldest member of the group on every cast, so the carrier placed
 * now survives exactly until the `maxAlive`-th cast after it. Its real life is therefore
 * `maxAlive × cycleSeconds`, not `life_ticks` — and a totem that pulses once a second, placed by
 * a button that comes back twice a second, never pulses at all.
 *
 * The figure this returns is the other way round: rather than shortening the carrier, it says how
 * slowly you would have to place them for each to live out its declared life, which is the pace a
 * player actually uses. One totem every `life / maxAlive` seconds keeps `maxAlive` of them up
 * permanently and wastes nothing; pressing faster than that only destroys your own. Undefined
 * whenever the button is already slower than that, because then nothing is being thrown away.
 *
 * The whole spawn chain is searched, not just the source's own carrier, and that is not a detail:
 * only three of the pack's totems damage from the totem block itself. `chaos_totem` places a
 * limited totem which drops an *unlimited* meteor every ten ticks, and the damage act hangs off
 * the meteor — so a scan of the damage source's own carrier finds no limit at all and reports a
 * spammable totem. The life that matters is the limited ancestor's, because that is the thing the
 * next cast destroys; the meteors it has already dropped outlive it.
 */
function sustainLimit(
  source: DamageSource,
  cycleSeconds: number,
): { group: string; maxAlive: number; periodSeconds: number } | undefined {
  if (cycleSeconds <= 0) return undefined;

  // Nearest first: an inner group would be culled before the outer one gets the chance.
  const carriers = [source.carrier, ...[...source.origin.chain].reverse().map((s) => s.carrier)];
  for (const carrier of carriers) {
    if (carrier.kind !== "summon_block" || carrier.limit === undefined) continue;
    const lifeSeconds = carrier.lifeTicks / TICKS_PER_SECOND;
    const periodSeconds = lifeSeconds / Math.max(1, carrier.limit.maxAlive);
    if (periodSeconds <= cycleSeconds) return undefined;
    return { group: carrier.limit.group, maxAlive: carrier.limit.maxAlive, periodSeconds };
  }
  return undefined;
}

/**
 * The tick of the last hit this source puts on the target.
 *
 * The carrier's death time is the wrong number: a projectile that lives 60 ticks but only
 * reaches the target for the first 20 of them stops contributing at 20, and a source that never
 * reaches the target at all contributes for 0. Reading it off the landing schedule keeps the
 * ramp honest in both directions.
 */
function lastLandingTick(coverage: Coverage, source: DamageSource): number {
  const ticks = coverage.landedTicks;
  if (ticks.length > 0) return Math.max(...ticks);
  // Nothing landed — but the carrier still existed, and for a source whose coverage was handed
  // to us rather than derived the schedule may be empty. Fall back to the carrier's life.
  return coverage.hitsPerCast > 0 ? source.carrier.lifeTicks : 0;
}

/**
 * Damage this skill has actually put on the target after `seconds` of sustained casting.
 *
 * Casts go out at `0, T, 2T, …`, and each one delivers its hits on the schedule
 * `Coverage.landedTicks` recorded — so this is the ramp, exactly, rather than `dps × seconds`.
 * The two converge once `seconds` passes `overlap.rampSeconds`.
 *
 * Fractional hits (a selection chance, a direct tick's expectation) are spread evenly across
 * that schedule rather than rounded, which is what keeps the curve's limit equal to `dps`.
 */
export function damageWithin(result: DpsResult, seconds: number): number {
  const cycle = result.rate.cycleSeconds;
  if (cycle <= 0 || seconds < 0) return 0;

  // A guard, not a model: a 0.05s cycle over a ten-minute window is 12,000 casts times a few
  // hundred ticks each, and nothing asking for a ramp needs that resolution.
  const casts = Math.min(Math.floor(seconds / cycle) + 1, MAX_RAMP_CASTS);
  let total = 0;

  for (const entry of result.sources) {
    const ticks = entry.coverage.landedTicks;
    const perCycle = result.rate.castsPerCycle;
    if (ticks.length === 0) {
      // No schedule: treat the whole contribution as landing with the cast.
      for (let k = 0; k < casts; k++) {
        if (k * cycle <= seconds) total += entry.damagePerCast * perCycle;
      }
      continue;
    }
    const per = (entry.hit.average.total * entry.coverage.hitsPerCast * perCycle) / ticks.length;
    for (let k = 0; k < casts; k++) {
      const start = k * cycle;
      if (start > seconds) break;
      for (const tick of ticks) {
        if (start + tick / TICKS_PER_SECOND <= seconds) total += per;
        else break; // `landedTicks` is sorted, so the rest of this cast is in the future too.
      }
    }
  }
  return total;
}

/** How long sustained casting takes to deal `health` damage, or undefined if it never does. */
export function timeToKill(result: DpsResult, health: number): number | undefined {
  if (health <= 0) return 0;
  if (result.dps <= 0) return undefined;

  // Walk forward a cycle at a time until the target is dead, then bisect inside that cycle.
  const cycle = result.rate.cycleSeconds;
  let low = 0;
  let high = cycle;
  const ceiling = result.overlap.rampSeconds + (health / result.dps) * 2 + cycle;
  while (damageWithin(result, high) < health) {
    low = high;
    high *= 2;
    if (high > ceiling) return undefined;
  }
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (damageWithin(result, mid) >= health) high = mid;
    else low = mid;
  }
  return high;
}

/** Casts simulated when drawing a ramp, so a rapid spell over a long window stays bounded. */
const MAX_RAMP_CASTS = 400;

// ---------------------------------------------------------------------------
// Full DPS
// ---------------------------------------------------------------------------

/**
 * The rotation figure, across every skill the document ticked into it.
 *
 * One pass casts each ticked skill once. What that costs in time is not the sum of the skills'
 * own cycles: a cast occupies its own cast time and then arms the shared global cooldown, so
 * the pass takes `Sum (castTicks + globalCooldownTicks)` -- unless one skill's *own* cooldown is
 * longer than the whole pass, in which case that cooldown is what you wait for.
 *
 * A skill that is off the global cooldown (`cast_speed_ticks <= 0`) still costs its cast time,
 * because you cannot be casting two things at once.
 *
 * ## Buffs are upkeep, not steps
 *
 * "Once per pass" is the wrong rate for a buff, and wrong by a lot. A `buff`-tagged skill that
 * puts nothing on the target is pressed when its effect runs out, which for the toggles in this
 * pack -- every stance, every aura, `banishing_blade` -- is `potion_dur: -1`: once, ever. Those
 * skills are charged `press / upkeepSeconds` of a pass instead of a whole one, which is zero for
 * a toggle, and are kept out of the `slowest` reduction as well, because a cooldown you are
 * never waiting on cannot be what the rotation waits for.
 *
 * That makes the pass length circular -- the upkeep share is a fraction *of the pass* -- so it
 * is solved rather than iterated:
 *
 *     R = Sum(rotation presses) / (1 - Sum(upkeep press / upkeep period))
 *
 * ## What the rotation sets off
 *
 * `procDps` is part of `dps` here, unlike in the single-skill figure. A proc is not a second
 * build you opted into; it is what the gear you are already wearing does while you press the
 * buttons you already press, and every skill in the pass contributes triggers to the same
 * shared `proc_cooldown_ticks` ceiling. {@link rotationProcs} merges them.
 */
export function simulateFullDps(
  build: BuildDoc,
  snapshot: Snapshot,
  options: DpsOptions = {},
): FullDpsResult {
  const skills = (build.skills ?? []).filter((s) => s.includeInFullDps === true && isSkillEnabled(s));
  const diagnostics: Diagnostic[] = [];

  const empty = (extra: Diagnostic[]): FullDpsResult => ({
    skills: [],
    rotationSeconds: 0,
    damagePerRotation: 0,
    auraDps: 0,
    skillDps: 0,
    procs: [],
    procDps: 0,
    dps: 0,
    critDps: 0,
    packDps: 0,
    ailmentDps: 0,
    ailmentProcDps: 0,
    diagnostics: [...diagnostics, ...extra],
  });

  if (skills.length === 0) {
    return empty([
      {
        severity: "info",
        code: "full-dps-empty",
        path: "skills",
        message:
          "No skill is ticked into Full DPS. Tick the skills you actually cast in a rotation - " +
          "a combo extender and the finisher it enables, say - to see what the rotation is worth. " +
          "Ticking a buff costs the rotation nothing: it is charged for its upkeep, not for a cast.",
      },
    ]);
  }

  type Entry = FullDpsSkill & { pressSeconds: number; role: FullDpsRole };
  const entries: Entry[] = [];

  for (const skill of skills) {
    const result = simulateDps(build, snapshot, { ...options, skill });
    if (!result) {
      diagnostics.push({
        severity: "warning",
        code: "full-dps-skill-failed",
        path: "skills",
        message: `\`${skill.spellId}\` is ticked into Full DPS but produced no damage figure.`,
      });
      continue;
    }
    // What one press of this skill takes out of the pass: its cast, then the shared arm it puts
    // on everything else. A skill off the global cooldown contributes only its cast time.
    const pressSeconds = result.rate.castSeconds + result.rate.globalCooldownSeconds;
    const buff = upkeepOf(result);

    if (buff === undefined) {
      entries.push({ skill, result, rotationSeconds: pressSeconds, pressSeconds, role: "rotation" });
      continue;
    }

    entries.push({
      skill,
      result,
      // Filled in below: it is a share of a pass length that is not known yet.
      rotationSeconds: 0,
      pressSeconds,
      role: buff.role,
      upkeepSeconds: buff.seconds,
      upkeepDurationSeconds: buff.durationSeconds,
      upkeepEffectId: buff.effectId,
      upkeepHolder: buff.holder,
    });

    // A buff whose cooldown outlasts its own effect cannot be kept up, and the sheet under this
    // figure assumes it is. Worth saying once, where the tick that asked for it is.
    if (buff.seconds > buff.durationSeconds) {
      diagnostics.push({
        severity: "info",
        code: "full-dps-buff-downtime",
        path: "skills",
        message:
          `\`${skill.spellId}\` keeps \`${buff.effectId}\` up for ` +
          `${buff.durationSeconds.toFixed(1)}s but cannot be re-cast for ` +
          `${buff.seconds.toFixed(1)}s, so it is down for ` +
          `${(buff.seconds - buff.durationSeconds).toFixed(1)}s of every cycle. The stats behind ` +
          `this figure assume it is up throughout.`,
      });
    }
  }

  if (entries.length === 0) return empty([]);

  const rotation = entries.filter((e) => e.role === "rotation");
  // An aura is charged nothing and waits for nothing, so it never appears in the solve below —
  // its whole contribution is the rate it pulses at, added at the end.
  const upkeep = entries.filter((e) => e.role === "upkeep");

  // Nothing but buffs is a legal thing to tick and a meaningless rotation, so it degrades to the
  // plain reading -- you press them one after another -- rather than dividing by zero.
  const buffsOnly = rotation.length === 0;
  if (buffsOnly) {
    const auraOnly = entries.every((e) => e.role === "aura");
    diagnostics.push({
      severity: "info",
      code: "full-dps-buffs-only",
      path: "skills",
      message: auraOnly
        ? "Every skill ticked into Full DPS is an aura, so the figure is what they pulse for on " +
          "their own — no button is being pressed. Tick the skill you actually attack with to " +
          "see the rotation."
        : "Every skill ticked into Full DPS is a buff, so the rotation is the presses themselves. " +
          "Tick the skill you actually attack with to see what those buffs are worth.",
    });
  }

  const paced = buffsOnly ? entries : rotation;
  const sequential = paced.reduce((sum, e) => sum + e.pressSeconds, 0);
  // A long individual cooldown stretches the whole pass: you cannot come back round to that
  // skill until it is ready, and the pass is defined as casting each ticked skill once. An
  // upkeep buff is exempt -- you are not standing there waiting for a toggle to come off cooldown.
  const slowest = paced.reduce((max, e) => Math.max(max, e.result.rate.cycleSeconds), 0);
  const base = Math.max(sequential, slowest);

  // Every upkeep press is a slice of the pass it interrupts, and the slices are a fraction *of*
  // the pass -- hence the solve rather than an addition. A toggle's period is Infinity, so it
  // contributes exactly nothing and the pass is the rotation's own length.
  const upkeepShare = buffsOnly
    ? 0
    : upkeep.reduce((sum, e) => sum + e.pressSeconds / (e.upkeepSeconds ?? Infinity), 0);
  if (upkeepShare >= 1) {
    diagnostics.push({
      severity: "warning",
      code: "full-dps-upkeep-unsustainable",
      path: "skills",
      message:
        `Re-casting the ticked buffs takes ${(upkeepShare * 100).toFixed(0)}% of your time on ` +
        "its own, so there is none left to attack in. The figure below caps the upkeep at 95% " +
        "rather than reporting an infinite rotation.",
    });
  }
  const rotationSeconds = base / (1 - Math.min(upkeepShare, 0.95));

  // Now the pass length is known, each upkeep press gets its share of it. An aura's period is
  // `Infinity`, so it gets none — which is the whole of "a toggle costs the rotation nothing".
  for (const entry of entries) {
    // What the aura this button holds pulses for, on every entry that holds one rather than only
    // on the ones whose tag made them a toggle.
    if (entry.result.auraDps > 0) entry.auraDps = entry.result.auraDps;
    if (entry.role === "rotation") continue;
    const presses =
      buffsOnly && entry.role !== "aura" ? 1 : rotationSeconds / (entry.upkeepSeconds ?? Infinity);
    entry.pressesPerRotation = presses;
    entry.rotationSeconds = entry.pressSeconds * presses;
  }

  const pressesOf = (entry: Entry): number =>
    entry.role === "rotation" ? 1 : (entry.pressesPerRotation ?? 0);

  // The aura share comes out of every per-press figure and goes back in as a rate. A permanent
  // carrier was counted over *its own* skill's cycle so that the division would cancel; a pass
  // through four buttons has a different length, and leaving the term in would have scaled Holy
  // Fire by the ratio between the two.
  const castDamage = (e: Entry): number => e.result.damagePerCast - e.result.auraDamagePerCast;
  const castCritDamage = (e: Entry): number =>
    e.result.critDamagePerCast - e.result.auraCritDamagePerCast;

  const damagePerRotation = entries.reduce(
    (sum, e) => sum + castDamage(e) * e.result.rate.castsPerCycle * pressesOf(e),
    0,
  );
  const critPerRotation = entries.reduce(
    (sum, e) => sum + castCritDamage(e) * e.result.rate.castsPerCycle * pressesOf(e),
    0,
  );
  // Every aura the pass holds, whatever role its button ended up in.
  const auraPerSecond = entries.reduce((sum, e) => sum + e.result.auraDps, 0);
  const auraCritPerSecond = entries.reduce((sum, e) => sum + e.result.auraCritDps, 0);
  const packSize = Math.max(1, options.packSize ?? build.config?.packSize ?? 1);

  if (base > sequential) {
    const bound = paced.reduce((a, b) => (a.result.rate.cycleSeconds > b.result.rate.cycleSeconds ? a : b));
    diagnostics.push({
      severity: "info",
      code: "full-dps-cooldown-bound",
      path: "skills",
      message:
        `The rotation waits on \`${bound.skill.spellId}\`: its own cooldown of ` +
        `${bound.result.rate.cycleSeconds.toFixed(2)}s is longer than the ` +
        `${sequential.toFixed(2)}s the casts themselves take.`,
    });
  }

  // The whole pass triggers one shared set of proc cooldowns, so the per-skill lists are merged
  // against the pass rather than added up. An upkeep buff lands no hits, so it contributes no
  // triggers -- what it contributes is the sheet every other row was computed on.
  const procs = rotationProcs(
    entries.map((e) => ({
      procs: e.result.procs,
      // An aura lands its hits whether or not you press anything, so it contributes triggers for
      // the whole length of the pass rather than for a press it never makes. `triggersPerSecond`
      // is already a real rate for it — two Holy Fire pulses a second, not two per cast — so the
      // pass length is what it multiplies by. Zeroing it with the presses is how a Holy Fire
      // build's procs would have disappeared the moment the aura stopped being a rotation step.
      cycleSeconds: e.role === "aura" ? rotationSeconds : e.result.rate.cycleSeconds,
      presses: e.role === "aura" ? 1 : pressesOf(e),
    })),
    rotationSeconds,
  );
  const procsPerSecond = procDps(procs);
  const skillDps =
    (rotationSeconds > 0 ? damagePerRotation / rotationSeconds : 0) + auraPerSecond;

  // An aura's ailments are on the aura's clock too: Holy Fire ignites at two pulses a second for
  // as long as it is up, and weighting that by presses-per-pass — zero, for a toggle — dropped
  // the whole burning half of a Holy Fire build.
  const ailmentWeight = (e: Entry): number => (e.role === "aura" ? 1 : pressesOf(e));

  return {
    skills: entries,
    rotationSeconds,
    damagePerRotation,
    auraDps: auraPerSecond,
    skillDps,
    procs,
    procDps: procsPerSecond,
    dps: skillDps + procsPerSecond,
    critDps:
      (rotationSeconds > 0 ? critPerRotation / rotationSeconds : 0) + auraCritPerSecond,
    packDps: (skillDps + procsPerSecond) * packSize,
    // Ailments run on their own clock and do not queue behind a cast, so they add rather than
    // divide.
    ailmentDps: entries.reduce((sum, e) => sum + e.result.ailmentDps * ailmentWeight(e), 0),
    ailmentProcDps: entries.reduce((sum, e) => sum + e.result.ailmentProcDps * ailmentWeight(e), 0),
    diagnostics: [...diagnostics, ...entries.flatMap((e) => e.result.diagnostics)],
  };
}

/**
 * Whether a ticked skill is something you keep up rather than a step you press, and how often.
 *
 * Everything here is answered from the pack's own declarations, in three questions:
 *
 *   - **is it an aura** -- `config.tags` says so, for thirteen spells. An aura is a toggle by
 *     construction: `holy_fire`'s `on_cast` is a pair of branches gated on whether you already
 *     hold the effect, so pressing the button a second time turns it *off*. It is never a
 *     rotation step, and the four that deal damage are no exception -- the damage is the
 *     effect's own component group ticking on its own `tick_rate`, not something the press
 *     produces. The pass is charged nothing for it and waits on nothing for it.
 *   - **is it pressed for a duration** -- a skill that puts no damage on the target is pressed
 *     for what it applies and nothing else: a buff on you, a curse on the pack, a banner on the
 *     ground. `cooldown_ticks` says how soon you *may* press it again; the effect's own duration
 *     says how soon you *have to*, and on `curse_of_damnation` those are 3s and 10s. Measured
 *     rather than declared, because a `damage` act that reaches nothing where the target stands
 *     is not a reason to press a button;
 *   - **how long does one press last** -- {@link DpsResult.buff} or {@link DpsResult.debuff},
 *     the longest-lived effect the press applies on that side, already scaled by the build's
 *     `eff_dur_u_cast` stats. The caster side is preferred when a press does both, because a
 *     buff you drop is a buff you notice; the debuff is what paces a pure curse.
 *
 * The period is `max(duration, the spell's own cycle)`: you re-press when it falls off, and no
 * faster than the cooldown allows. Both halves of that `max` move with the gems now — duration
 * with Effect Duration, the cycle with Cooldown — which is what makes either one worth linking
 * to one of these at all.
 */
function upkeepOf(result: DpsResult):
  | {
      role: Exclude<FullDpsRole, "rotation">;
      seconds: number;
      durationSeconds: number;
      effectId: string;
      holder: "caster" | "target";
    }
  | undefined {
  const aura = result.declared.tags.includes("aura");
  // A toggle that hits is still a toggle. Everything else earns its way out of the rotation by
  // putting nothing on the target.
  if (!aura && result.damagePerCast > 0) return undefined;

  // `result.buff` / `result.debuff` rather than a second walk of the spell: they are the same
  // upkeep answers with the `eff_dur_u_cast` sweep already applied, and the rotation has to be
  // paced by the duration the build really gets. Re-deriving it here is how the Effect Duration
  // support gem would have gone on doing nothing to the pass length.
  const held = result.buff;
  const applied = result.debuff;
  const chosen = held ?? applied;
  if (chosen === undefined) {
    // An aura with nothing to pace it is still free: it is up, and the pass does not wait for
    // it. Anything else with no effect to expire is a button you are pressing for no stated
    // reason, so it stays a rotation step and the pass is charged for it.
    if (!aura) return undefined;
    return {
      role: "aura",
      seconds: Number.POSITIVE_INFINITY,
      durationSeconds: Number.POSITIVE_INFINITY,
      effectId: result.spellId,
      holder: "caster",
    };
  }

  const durationSeconds = chosen.durationSeconds;
  return {
    role: aura ? "aura" : "upkeep",
    // Every aura in this pack is `potion_dur: -1` and comes out of this as `Infinity`; the max
    // is written the same way for both sides so that one which is not would still be charged.
    seconds: Math.max(durationSeconds, result.rate.cycleSeconds),
    durationSeconds,
    effectId: chosen.effectId,
    holder: held !== undefined ? "caster" : "target",
  };
}

export type { ElementName };

/**
 * What a Shatter or a Shock is worth per second.
 *
 * Freeze and electrify deal no damage when they land. They add to a pool on the target, and a
 * later hit carrying `freeze_proc_chance` or `electrify_proc_chance` releases the whole of it as
 * one `dot` event — `EntityAilmentData.shatterAccumulated`, which takes `dmgMap`'s entry, removes
 * it, and fires `EventBuilder.ofDamage(source, target, (int) pool)`. Until now the pool was
 * computed, reported on the Damage tab as "accumulates N", and then left out of the ailment DPS
 * entirely, so a build stacking Shatter read as though its cold damage did nothing at all.
 *
 * The pool is a leaking bucket, so the figure is a steady state rather than a sum. Per second it
 * gains what your hits put in, and loses two ways:
 *
 *     gain   = accumulated x chance x r          (r = hits per second)
 *     decay  = poolDecayPerSecond x pool
 *     procs  = (procChance x r) x pool
 *
 * Setting gain against the two losses and solving for the pool gives a proc rate of
 *
 *     accumulated x chance x r x  (procChance x r) / (procChance x r + poolDecayPerSecond)
 *
 * — the accumulation rate, times the share of the bucket that reaches a proc instead of leaking.
 * The shape is worth reading: with no proc chance it is zero however much you accumulate, and
 * with a fast rotation and a high proc chance it converges on the accumulation rate, because
 * everything you put in eventually comes out. In between, the decay is what a point of proc
 * chance is buying.
 *
 * `chance` is applied here where the DoT branch does not apply it, and the difference is real: a
 * refreshed DoT is either up or not and is reported as its rate while up, whereas every inflicted
 * freeze adds to the same pool, so a 40% freeze chance really does fill it at 40% of the rate.
 *
 * The rate used is casts per second rather than hits. A multi-hit cast fills the pool faster
 * *and* tips it more often, and those pull in opposite directions in the ratio above, so the
 * error is second-order — but it is an under-count for a multi-hit spell, and saying so is
 * cheaper than implying a precision this does not have.
 */
function procPerSecond(ailment: AilmentResult, castsPerSecond: number): number {
  return procPool(ailment, castsPerSecond) * ailment.procChance * castsPerSecond;
}

/**
 * How big the pool is when a proc finds it — the size of one Shatter or one Shock.
 *
 * The steady state of the same leaking bucket {@link procPerSecond} describes, read for the
 * level rather than for the flow. Setting the gain against the two losses:
 *
 *     accumulated x chance x r = pool x (procChance x r + poolDecayPerSecond)
 *
 * so
 *
 *     pool = accumulated x chance x r / (procChance x r + poolDecayPerSecond)
 *
 * and the proc rate above is this times how often it is tipped, `procChance x r`. Writing the
 * two that way round rather than as two independent expressions is what stops the spike on
 * screen from being a number the DPS beside it was not computed from.
 *
 * The shape is worth reading. With no decay it converges on `accumulated x chance / procChance`
 * — exactly "one shatter's worth of hits, each contributing its average" — and the decay is what
 * pulls it below that. So a slow rotation has a *smaller* spike as well as a rarer one, because
 * 10% a second leaks off a pool that is kept waiting.
 */
function procPool(ailment: AilmentResult, castsPerSecond: number): number {
  if (ailment.procChance <= 0 || ailment.accumulated <= 0 || castsPerSecond <= 0) return 0;
  const procRate = ailment.procChance * castsPerSecond;
  return (
    (ailment.accumulated * ailment.chance * castsPerSecond) /
    (procRate + ailment.poolDecayPerSecond)
  );
}
