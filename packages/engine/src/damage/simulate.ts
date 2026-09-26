/**
 * The damage event, end to end.
 *
 * `EffectEvent.Activate()` in four steps (EffectEvent.java:181-209): seed the numbers, sweep
 * both sides' stats in priority order, flush the layers, then expand whatever conversion
 * produced into fresh events. This file is the driver; the arithmetic lives in `layers.ts`,
 * the interpretation in `effects.ts` / `conditions.ts` / `code-only-effects.ts`.
 *
 * ## Crit is branched, not averaged
 *
 * `critical_damage` writes a MULTIPLY layer gated on the `crit` boolean, and `non_crit_damage`
 * writes a different one gated on its negation. Averaging the two gates produces a number the
 * game cannot produce for either outcome. So the whole pipeline runs twice with `crit` pinned,
 * and the weighted mean of the two results is reported alongside them — which is also what a
 * player means by "my DPS".
 *
 * ## What the sweep reads
 *
 * The source side reads the **spell unit** (`calculate` with `skill` set: support gems and the
 * spell's innate stats folded in). The base damage number does *not* — `ScalingCalc` reads
 * `Load.Unit(en).getUnit()`, the plain character sheet. Both sheets are therefore computed and
 * they are not interchangeable.
 */

import type { Snapshot } from "@cte2/extractor";
import type { BuildDoc, Diagnostic, ElementName, EnemySetup, Severity, SkillSetup } from "@cte2/schema";
import { CATEGORY, CODE_ONLY_TRANSFERS, ELEMENTS, SINGLE_ELEMENTS, entry, isDualWielding } from "@cte2/schema";

import { balance } from "../balance.js";
import { calculate, type EngineResult, type EngineStat } from "../calculate.js";
import { ORIGINAL_MODE, type Compat } from "../compat.js";
import { maxSpellLevel, spellLevel } from "../collect/spell.js";
import { statIndex, type EffectBlock, type StatIndex } from "../stat-def.js";
import { applyAilments, type Ailment, type AilmentEvent, type AilmentResult } from "./ailments.js";
import { Recorder, type EventTrace, type LayerStep, type MoreStep } from "./breakdown.js";
import { evaluateIfs } from "./conditions.js";
import { applyStatEffect } from "./effects.js";
import { multiplyExact, parseRolledMods, rollToExact, type ModType } from "../modifier.js";
import { mobAffixDiagnostics, mobAffixMods } from "./mob-affixes.js";
import { mapMobMods } from "./map.js";
import { activeOn, type EffectState } from "./effect-state.js";
import { inCodeEffects, MAX_CONVERSION_DEPTH } from "./code-only-effects.js";
import { sheetValue, type DamageCtx, type ProcHit, type RestoreRecord, type Sheet } from "./ctx.js";
import { DamageEventState, EVENT, type EffectSide } from "./event.js";
import { LAYER, layerIndex, type LayerIndex } from "./layers.js";
import { PRIORITY, UNKNOWN_ORDER_PRIORITY, datapackPriority } from "./priority.js";
import { calculatedValue, damageEffectiveness, valueCalc } from "./value-calc.js";

/** `DamageEvent.ID` — the event GUID a datapack `effect` block must list to take part. */
export const ON_DAMAGE = "on_damage";
/**
 * `DamageInitEvent.ID` — the pass `initBeforeActivating()` runs before the hit's own sweep.
 *
 * One stat in this pack answers it, `no_attacker_stats_on_selfdmg`, and what it does there could
 * not be done anywhere else: it decides whether the attacker's side of the sweep is assembled.
 */
export const ON_DAMAGE_INIT = "on_damage_init";

export type DamageOptions = {
  balanceId?: string;
  baseStatsId?: string;
  /** Which skill to resolve. Defaults to the one marked `main`, else the first. */
  skill?: SkillSetup;
  compat?: Compat;
  /** Overrides the spell's own declared damage element and value calc, for a specific act. */
  element?: ElementName;
  valueCalcId?: string;
  /**
   * Record how each number was reached, for the damage breakdown. Off by default: the
   * pipeline runs twice per call and every bonus element is a nested event, so tracing is
   * paid for only when something is going to read it.
   */
  breakdown?: boolean;
  /**
   * Sheets computed by the caller, to be used instead of computing them again.
   *
   * A spell with several damage sources resolves each one through this function with a
   * different `value_calculation`, and the two sheets are identical across all of them —
   * they depend on the build and the skill, not on the act. Recomputing them per source made
   * `raging_dragon` six `calculate` passes instead of two. Nothing else changes: when this is
   * absent the sheets are computed exactly as before.
   */
  sheets?: { character: EngineResult; spell: EngineResult };
  /**
   * Which exile effects are up, resolved by the caller.
   *
   * `dps.ts` resolves it once per skill and hands the same state to the stat sheets, the rate
   * sweep, the damage event and the source walk, so all of them agree about which branch of a
   * spell is being described. A caller that passes none gets whatever `calculate` resolved while
   * building the character sheet, which is the same answer arrived at without the skill's own
   * gates to break an exclusivity tie.
   */
  effects?: EffectState;
  /** Collect the `proc_spell` blocks the sweep reaches. Off by default; it is a per-skill answer. */
  procs?: boolean;
  /**
   * Resolve this hit against the **caster** rather than against the declared enemy.
   *
   * Ten spells declare a `damage` act at a `self` selector and charge you for casting them —
   * `asura` takes 50% of your health plus 50% of your magic shield. Those acts already contribute
   * nothing to DPS, which is right; what they need is to be resolved at all, and against the
   * right defences. Three things change and each is the game's own:
   *
   *  - **the target sheet is the character's**, so `armor_mitigation`, the resists and
   *    `dmg_received` are yours;
   *  - **`source_is_target` is true**, which is half of what `no_attacker_stats_on_selfdmg` asks;
   *  - **`on_damage_init` runs first**, and in this pack it fires `disable_attacker_stats`, so
   *    the attacker half of the sweep never happens (`EffectEvent` line 255:
   *    `if (calcSourceEffects) { … AddEffects(… EffectSides.Source) }`).
   *
   * That last one is why a self-hit takes none of your own `attack_damage` or `spell_damage` —
   * and it is visible in the game's log as a block with `[Target]` lines and no `[Source]` ones.
   */
  selfHit?: boolean;
  /**
   * A pet's bite rather than your own cast — `DamageAction` sets `IS_SUMMON_ATTACK` when the
   * spell's source entity is a summon, and `buildBonusElementEvent` copies it onto every bonus
   * event. Stats gate on it both ways: the golem buffs need it, and `proc_target` and the
   * `*_on_basic_hit` resource stats refuse it.
   */
  summonAttack?: boolean;
};

/** One resolved outcome — a whole pass of the pipeline. */
export type HitOutcome = {
  /** Total damage across every element. */
  total: number;
  /** Per element, including the bonus events conversion spawned. */
  byElement: Map<ElementName, number>;
  ailments: AilmentResult[];
  /**
   * Every `restore_resource` block the sweep reached — leech, in this pack.
   *
   * One entry per stat that fired, with the number it fed the restore event. Collected for both
   * branches because leech is a percent of the damage *dealt*, so a crit leeches more.
   */
  restores: RestoreRecord[];
  /** Present only with `options.breakdown`. The root event, with its bonus events nested. */
  trace?: EventTrace;
};

export type DamageResult = {
  spellId: string;
  /** `mmorpg_value_calc` output, before the event touches it. What the tooltip prints. */
  baseValue: number;
  dmgEffectiveness: number;
  element: ElementName;
  critChance: number;
  /**
   * The share of this act's hits that are not evaded — `damage_block`'s multiplier.
   *
   * 1 wherever nothing can dodge the hit: `DodgeRating` takes non-`magic` hits of any element
   * and `SpellDodgeEffect` takes `magic` spells, and a mob with no evasion rating leaves the
   * layer unwritten either way. Reported rather than left inside the number
   * because it is already folded into every total here, and a figure that quietly assumes a
   * target you never miss is one the reader cannot check.
   */
  hitChance: number;
  /** Whether this was resolved against the caster — see {@link DamageOptions.selfHit}. */
  selfHit: boolean;
  /** `crit` pinned false. */
  hit: HitOutcome;
  /** `crit` pinned true. */
  crit: HitOutcome;
  /**
   * `hit` and `crit` weighted by `critChance`.
   *
   * It carries no trace, and cannot: `crit_damage` gates a multiplicative layer and
   * `double_damage` is pinned to exactly x2, so an averaged layer is a row the game never
   * produces. The two branches each carry their own.
   */
  average: HitOutcome;
  /**
   * The character sheet and the spell unit that fed this hit, so a breakdown can name the item,
   * perk, gem or aura behind a stat rather than only the stat. Both are computed regardless;
   * returning them costs nothing.
   */
  sheets: { character: EngineResult; spell: EngineResult };
  /**
   * The enemy this hit landed on, as the mitigation layers saw it.
   *
   * Separate from `sheets` because it is not one of the character's: `sheets.character` is who
   * you are and this is what you hit. A `[Target]` row in a breakdown resolves against this,
   * and resolving it against the character instead is not a smaller mistake — it files the
   * mob's armour under your chestplate.
   *
   * `origins` covers only the stats something aimed at: a mob affix or one of your debuffs. A
   * stat the enemy simply declared has nothing to explain and is read off `sheet`.
   */
  target: { sheet: Sheet; origins: ReadonlyMap<string, TargetStatOrigin> };
  /**
   * `proc_spell` blocks the sweep reached, per branch.
   *
   * Collected only when `options.procs` asks for them, because a spell with six damage sources
   * resolves six hits and every one of them would report the same list. `dps.ts` asks once.
   */
  procs?: { onHit: ProcHit[]; onCrit: ProcHit[] };
  diagnostics: Diagnostic[];
};

export function simulateHit(
  build: BuildDoc,
  snapshot: Snapshot,
  options: DamageOptions = {},
): DamageResult | undefined {
  const diagnostics: Diagnostic[] = [];
  const report = (severity: Severity, code: string, path: string, message: string): void => {
    diagnostics.push({ severity, code, path, message });
  };

  const skill = options.skill ?? mainSkill(build, report);
  if (!skill) {
    report("error", "no-skill", "skills", "This build declares no skill, so there is no damage to compute.");
    return undefined;
  }

  const spell = entry(snapshot, CATEGORY.spell, skill.spellId)?.data;
  if (!spell) {
    report("error", "unknown-spell", "skills", `No ${CATEGORY.spell} entry \`${skill.spellId}\`.`);
    return undefined;
  }

  const index = statIndex(snapshot);
  const layers = layerIndex(snapshot);
  const bal = balance(snapshot, options.balanceId);
  const compat = options.compat ?? ORIGINAL_MODE;

  const baseOptions = pick(options);
  // Two sheets, deliberately. The character sheet feeds `value_calc`; the spell unit feeds the
  // event's source-side sweep. Both are built with the same effects up as the gates and the
  // mob's debuffs below — a buff that is off here has to be off everywhere, which is the whole
  // reason the state is resolved once and handed down rather than asked for three times.
  const sheetOptions = {
    ...baseOptions,
    ...(options.effects === undefined ? {} : { effects: options.effects }),
  };
  const characterRun = options.sheets?.character ?? calculate(build, snapshot, sheetOptions);
  const characterSheet = characterRun.stats;
  const spellRun = options.sheets?.spell ?? calculate(build, snapshot, { ...sheetOptions, skill });
  // Only when this call computed them: a caller passing sheets in has already collected these.
  if (options.sheets === undefined) diagnostics.push(...spellRun.diagnostics);
  const sourceSheet = spellRun.stats;
  const effects = options.effects ?? characterRun.effects;
  // A self-hit lands on you, so the mitigation layers read your sheet. The enemy's debuffs are
  // not applied to it: `shred` and `elemental_weakness` are things you put on the mob, and
  // carrying them across would have your own recoil shredding you.
  const selfHit = options.selfHit === true;
  // Collected unconditionally: it is one map of the stats a debuff or an affix touched, which
  // is a handful of entries, and the Damage tab always wants to be able to explain one.
  const targetOrigins = new Map<string, TargetStatOrigin>();
  const targetSheet = selfHit
    ? characterSheet
    : targetSheetFor(build, effects, snapshot, index, bal, report, targetOrigins);

  const act = damageAct(spell, options);
  if (!act) {
    report(
      "warning",
      "no-damage-action",
      `skills`,
      `\`${skill.spellId}\` declares no \`damage\` action, so it deals no direct damage. Its output is entirely procs, ailments or summons, none of which this figure covers.`,
    );
  }

  const env = { snapshot, balance: bal, level: build.character.level };
  const level = spellLevel(envOf(env, index, bal), skill.spellId, spell, skill.level);
  const maxLevel = maxSpellLevel(envOf(env, index, bal), spell);

  const calcId = options.valueCalcId ?? act?.valueCalcId ?? "";
  const calc = calcId.length > 0 ? valueCalc(snapshot, calcId) : undefined;
  if (calcId.length > 0 && !calc) {
    report("error", "unknown-value-calc", "skills", `No ${CATEGORY.valueCalc} entry \`${calcId}\`.`);
  }

  const read = (sheet: Sheet) => (statId: string) => sheetValue(sheet, statId);
  const baseValue = calc
    ? calculatedValue(
        calc,
        read(characterSheet),
        read(targetSheet),
        level,
        maxLevel,
        build.character.level,
        bal,
        compat,
      )
    : 0;
  const effectiveness = calc ? damageEffectiveness(calc, level, maxLevel) : 1;

  const element = options.element ?? act?.element ?? "Physical";
  const critChance = clamp01(sheetValue(sourceSheet, "critical_hit") / 100);

  const shared = {
    snapshot,
    index,
    layers,
    balance: bal,
    compat,
    build,
    skill,
    spell,
    sourceSheet,
    targetSheet,
    baseValue,
    effectiveness,
    element,
    effects,
    breakdown: options.breakdown === true,
    basicAttack: false,
    summonAttack: options.summonAttack === true,
    // `ofSpellDamage` takes the style from `spell.getConfig().getStyle()`, not from the weapon:
    // a caster swinging a dagger is still casting an `int` spell. Unset, `style_is_int_is_false`
    // read true for every hit, which handed thirteen attack-only stats — `attack_damage`,
    // `lifesteal`, `elemental_attack_damage` and four attack procs — to INT spells that the game
    // does not give them to.
    style: spellStyle(spell),
    selfHit,
    sourceStatsDisabled: false,
    hitChance: 1,
  };

  const procs = options.procs === true ? { onHit: [] as ProcHit[], onCrit: [] as ProcHit[] } : undefined;
  const hit = runBranch(shared, false, diagnostics, procs?.onHit);
  const crit = runBranch(shared, true, diagnostics, procs?.onCrit);

  // `critical_hit` sets `EventData.CRIT` from the **Source** side, so a hit whose attacker sweep
  // `disable_attacker_stats` removed never rolls one. Reporting the sheet's chance there would
  // put a crit column on a self-hit that the game can only ever resolve as a normal one.
  const rolledCrit = shared.sourceStatsDisabled ? 0 : critChance;

  return {
    spellId: skill.spellId,
    baseValue,
    dmgEffectiveness: effectiveness,
    element,
    critChance: rolledCrit,
    hitChance: shared.hitChance,
    selfHit,
    hit,
    crit,
    average: blend(hit, crit, rolledCrit),
    sheets: { character: characterRun, spell: spellRun },
    target: { sheet: targetSheet, origins: targetOrigins },
    ...(procs === undefined ? {} : { procs }),
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// One branch
// ---------------------------------------------------------------------------

type Shared = {
  snapshot: Snapshot;
  index: StatIndex;
  layers: LayerIndex;
  balance: ReturnType<typeof balance>;
  compat: Compat;
  build: BuildDoc;
  skill: SkillSetup;
  spell: Record<string, unknown>;
  sourceSheet: Sheet;
  targetSheet: Sheet;
  baseValue: number;
  effectiveness: number;
  element: ElementName;
  effects: EffectState;
  breakdown: boolean;
  /**
   * `DamageEventBuilder.setIsBasicAttack()` — a weapon swing rather than a cast.
   *
   * It is one boolean on the event and a whole family of stats hangs off it: `BonusAttackDamage`
   * checks `data.isBasicAttack() && getAttackType() == hit`, and every `proc_*_on_basic_hit` in
   * the pack gates on `is_is_basic_atk_true`. Nothing else about the pipeline differs — the same
   * fourteen layers, the same sweep — so this is carried on `Shared` rather than forked.
   */
  basicAttack: boolean;
  /** A pet's hit — see {@link DamageOptions.summonAttack}. Copied onto every bonus event. */
  summonAttack: boolean;
  /** `PlayStyle.id` — `str`, `dex` or `int`, off the mainhand's base gear type. */
  style: string;
  /** The caster is the thing being hit — see {@link DamageOptions.selfHit}. */
  selfHit: boolean;
  /**
   * Written back by the root event: whether `on_damage_init` switched the attacker's sweep off.
   *
   * Mutable because the answer comes from running the pass, not from reading a field — the
   * condition lives in `no_attacker_stats_on_selfdmg`'s own datapack `ifs` and copying it here
   * would be a second copy to keep in step. The one caller is the crit chance: `critical_hit` is
   * an attacker stat, so a hit whose attacker half never ran cannot roll one.
   */
  sourceStatsDisabled: boolean;
  /**
   * `damage_block`'s multiplier off the root event — written by `runEvent` at depth 0.
   *
   * Mutable for the same reason {@link Shared.sourceStatsDisabled} is: it is a fact the event
   * discovers and the caller reports, and threading a twelfth out-parameter through a recursive
   * `runEvent` to carry one number would cost more than it explains.
   */
  hitChance: number;
};

function runBranch(
  shared: Shared,
  crit: boolean,
  diagnostics: Diagnostic[],
  procs: ProcHit[] | undefined,
): HitOutcome {
  const byElement = new Map<ElementName, number>();
  const ailments: AilmentResult[] = [];
  // One list for the whole branch, bonus-element events included: a converted half is a real
  // `DamageEvent` that runs the source sweep of its own, so `fire_mana_leech` leeches off the
  // fire half of a physical hit exactly as it would off a fire one.
  const restores: RestoreRecord[] = [];

  // Both branches report, but only once per distinct diagnostic: the two runs differ solely in
  // a pinned boolean, so nearly every message is identical in both, and an earlier version
  // dropped the non-crit branch's entirely to avoid the duplication. That also dropped the few
  // that are genuinely branch-specific — a crit-only layer being averaged, for one.
  const sink: Diagnostic[] = [];
  const events: ProcHit[] | undefined = procs === undefined ? undefined : [];
  const trace = runEvent(shared, shared.element, shared.baseValue, crit, 0, false, byElement, ailments, sink, events, restores);
  mergeDiagnostics(diagnostics, sink);
  if (procs !== undefined && events !== undefined) procs.push(...eitherEvent(events));

  let total = 0;
  for (const amount of byElement.values()) total += amount;
  return { total, byElement, ailments, restores, ...(trace ? { trace } : {}) };
}

/**
 * One entry per proc for the whole hit, where the hit and its bonus-element events each rolled
 * it: `1 - Π(1 - p)`, because each event rolls independently and the proc fires if any does.
 */
function eitherEvent(hits: readonly ProcHit[]): ProcHit[] {
  const out = new Map<string, ProcHit>();
  for (const hit of hits) {
    const key = `${hit.statId}:${hit.spellId}:${hit.side}`;
    const seen = out.get(key);
    if (seen === undefined) out.set(key, { ...hit });
    else seen.chance = 1 - (1 - seen.chance) * (1 - hit.chance);
  }
  return [...out.values()];
}

/** Appends the diagnostics the other branch has not already reported, keyed on code and path. */
function mergeDiagnostics(into: Diagnostic[], from: readonly Diagnostic[]): void {
  const seen = new Set(into.map((d) => `${d.code}|${d.path}|${d.message}`));
  for (const d of from) {
    const key = `${d.code}|${d.path}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    into.push(d);
  }
}

/**
 * One `DamageEvent`, including the bonus-element events it spawns.
 *
 * `takenAs` mirrors `DamageEvent.buildBonusElementEvent`: a `DAMAGE_TAKEN_AS` child skips the
 * source-side sweep entirely, because that damage has already been fully multiplied and
 * sweeping the attacker again would apply every offensive stat twice.
 */
function runEvent(
  shared: Shared,
  element: ElementName,
  amount: number,
  crit: boolean,
  depth: number,
  takenAs: boolean,
  byElement: Map<ElementName, number>,
  ailments: AilmentResult[],
  diagnostics: Diagnostic[],
  procs: ProcHit[] | undefined,
  restores: RestoreRecord[],
): EventTrace | undefined {
  if (depth > MAX_CONVERSION_DEPTH) return undefined;

  const recorder = shared.breakdown ? new Recorder() : undefined;
  const event = new DamageEventState(shared.layers, undefined, recorder);
  event.conversionDepth = depth;
  event.data.setupNumber(EVENT.NUMBER, amount);
  event.data.setupNumber(EVENT.DMG_EFFECTIVENESS, shared.effectiveness);
  event.data.setString(EVENT.ELEMENT, element);
  event.data.setString(EVENT.ATTACK_TYPE, depth === 0 ? "hit" : "bonus_dmg");
  event.data.setString(EVENT.SPELL, shared.skill.spellId);
  event.data.setString(EVENT.WEAPON_TYPE, weaponType(shared));
  event.data.setBoolean(EVENT.CRIT, crit);
  // `setupDamage(AttackType.hit, weptype, style)` sets the style on every damage event; only a
  // weapon swing also sets the basic-attack flag, and only at depth 0 — a converted bonus
  // element is `bonus_dmg`, which `BonusAttackDamage` refuses alongside the flag.
  if (shared.style.length > 0) event.data.setString(EVENT.STYLE, shared.style);
  if (shared.basicAttack) event.data.setBoolean(EVENT.IS_BASIC_ATTACK, true);
  if (shared.summonAttack) event.data.setBoolean(EVENT.IS_SUMMON_ATTACK, true);
  if (depth > 0) event.data.setBoolean(EVENT.IS_BONUS_ELEMENT_DAMAGE, true);

  // The weapon's own basic-attack multiplier, which `initBeforeActivating` registers before any
  // stat is swept:
  //
  //     if (this.data.isBasicAttack()) {
  //         if (this.attackInfo != null && attackInfo.weaponData != null) {
  //             if (!data.getBoolean(EventData.UNARMED_ATTACK)) {
  //                 float multi = attackInfo.weaponData.GetBaseGearType().getGearSlot().getBasicDamageMulti();
  //                 this.wepdmgMulti = multi;
  //                 this.addMoreMulti(() -> Words.WEAPON_BASIC_ATTACK_DMG_MULTI.locName(), EventData.NUMBER, multi);
  //             }
  //         }
  //     }
  //
  // It is a property of the *slot*, not of the item: `GearSlot.getBasicDamageMulti()` returns
  // `weapon_data.damage_multiplier`, which ranges from 0.9 on a gauntlet to 2.8 on a crossbow.
  // Nothing in the engine applied it, so every swing in this planner was wrong by that factor —
  // 1.6 on the axe this was found with, and the only reason it went unnoticed is that a basic
  // attack had no rate at all until last session and so was reported as zero anyway.
  //
  // `!takenAs`, not `depth === 0`: the game re-applies it to every converted element as well.
  // `buildBonusElementEvent` builds the child from the parent's own `attackInfo`
  //
  //     DamageEvent bonus = EventBuilder.ofDamage(attackInfo, source, target, amount)
  //     …
  //     x.data.setBoolean(EventData.IS_BASIC_ATTACK, this.data.getBoolean(EventData.IS_BASIC_ATTACK));
  //     …
  //     if (!takenAs) { bonus.initBeforeActivating(); }
  //
  // so both conditions the multi is behind — `isBasicAttack()` and a non-null
  // `attackInfo.weaponData` — hold on the child, and `initBeforeActivating` runs the whole block
  // again. (The `addMoreMulti` next to `if (wepdmgMulti != 1)` in that builder is commented out
  // for the same reason: it would have applied it twice.) A damage-*taken*-as child is the one
  // that skips it, because it has already been through every attacker multiplier on the parent.
  //
  // On a converting basic-attack build the old guard under-reported every converted element by
  // the full slot multiplier — 1.6× on an axe, 2.8× on a crossbow.
  if (shared.basicAttack && !takenAs) {
    const multi = basicAttackWeaponMulti(shared);
    // An unarmed swing gets none of it, matching the `UNARMED_ATTACK` guard. A build with no
    // weapon also has no `weapon_damage`, so it is already dealing nothing.
    if (multi !== undefined) event.addMoreMulti(WEAPON_BASIC_ATTACK_MULTI, EVENT.NUMBER, multi);
  }

  const ctx: DamageCtx = {
    snapshot: shared.snapshot,
    index: shared.index,
    balance: shared.balance,
    compat: shared.compat,
    event,
    source: shared.sourceSheet,
    target: shared.targetSheet,
    sourceLevel: shared.build.character.level,
    targetLevel: shared.selfHit
      ? shared.build.character.level
      : (shared.build.config?.enemy?.level ?? shared.build.config?.enemyLevel ?? shared.build.character.level),
    spell: shared.spell,
    spellId: shared.skill.spellId,
    spellTags: spellTags(shared.spell),
    config: shared.build.config ?? {},
    effects: shared.effects,
    ...(procs === undefined ? {} : { procs }),
    restores,
    diagnostics,
    report: (severity, code, path, message) => diagnostics.push({ severity, code, path, message }),
    reportedConditions: new Set(),
    reportedEffects: new Set(),
    // Pinning `crit` is what makes this a branch rather than a re-roll: `critical_hit`'s own
    // `set_bool` at priority 0 is skipped, so the boolean stays as the caller set it.
    pinnedBooleans: new Set([EVENT.CRIT]),
    disableSourceStats: takenAs,
    sourceIsTarget: shared.selfHit,
    sourceDualWielding: isDualWielding(shared.snapshot, shared.build.gear ?? []),
    ...(shared.selfHit ? { targetDualWielding: isDualWielding(shared.snapshot, shared.build.gear ?? []) } : {}),
  };

  // `initBeforeActivating()` raises a whole `DamageInitEvent` before the hit's own effect list is
  // built, and `DisableSourceStatsEffect` is the only thing in this pack that answers it:
  //
  //     if (event instanceof DamageInitEvent e) { e.dmg.calcSourceEffects = false; }
  //
  // The ordering is the point. `EffectEvent` decides whether to add the source side *after* the
  // init event has run, so a flag set there removes the attacker from the sweep entirely rather
  // than being one more effect inside it. No layer exists yet, so the pass does not flush.
  if (!takenAs) {
    sweep(ctx, [{ side: "Source", sheet: shared.sourceSheet }], [], [], ON_DAMAGE_INIT, false);
    if (depth === 0 && ctx.disableSourceStats) shared.sourceStatsDisabled = true;
  }

  const steps: LayerStep[] = [];
  const moreMultis: MoreStep[] = [];
  sweep(
    ctx,
    [
      // `takenAs` is `DisableSourceStatsEffect`: the attacker's sweep is skipped entirely for the
      // converted half of a hit, because it has already been applied to the original. So is a
      // self-hit, by the same flag — set by `no_attacker_stats_on_selfdmg` in the pass above.
      ...(takenAs || ctx.disableSourceStats ? [] : [{ side: "Source" as const, sheet: shared.sourceSheet }]),
      { side: "Target" as const, sheet: shared.targetSheet },
    ],
    steps,
    moreMultis,
  );

  /*
    What fraction of this cast's hits actually land, off the root event.

    `damage_block` is the layer dodge and spell dodge average themselves onto, so its multiplier
    *is* the chance to hit — 1 on the hits nothing can evade, which is most of them. Read at
    depth 0 only: a bonus-element child carries `bonus_dmg`, which dodge refuses outright, so a
    child would always report 1 and overwrite the parent's real figure.

    Kept on `shared` for the same reason `sourceStatsDisabled` is: it is one fact about the cast
    that the caller needs and the event that knows it is three frames down.
  */
  if (depth === 0) shared.hitChance = event.hitChance;

  // The children have to be collected before the trace is closed, because a bonus element is a
  // whole nested event and its own layers belong under this one.
  const children = collectBonusElements(
    ctx,
    event,
    shared,
    crit,
    depth,
    byElement,
    ailments,
    diagnostics,
    restores,
  );

  const dealt = Math.max(0, event.damage);
  byElement.set(element, (byElement.get(element) ?? 0) + dealt);

  /*
    Every event that sweeps the attacker rolls its own ailment, not just the hit itself.

    `AilmentChance.Effect` is a Source-side effect at `FINAL_DAMAGE`, and its gate ends

        && (effect.getAttackType().isHit() || effect.getAttackType() == AttackType.bonus_dmg)

    — checked against the 6.4.13 jar, not only the fork. `bonus_dmg` is exactly what
    `buildBonusElementEvent` stamps on a converted element, and that child runs the whole sweep
    (`calcSourceEffects = !takenAs`), so the cold half of an 80%-converted physical hit is an
    ordinary cold hit as far as `freeze_chance` is concerned. Gating on `depth === 0` silently
    dropped it: the physical reading of Tailwind Sweep converts four fifths of itself to cold on
    a build with freeze chance and reported no ailment at all.

    The condition is `disableSourceStats`, which is the same thing the sweep above is gated on —
    a `damage_taken_as` child, or a self-hit that hit `no_attacker_stats_on_selfdmg`, never runs
    a Source-side effect and so cannot roll one either.
  */
  if (!ctx.disableSourceStats) {
    ailments.push(
      ...applyAilments(ctx, shared.sourceSheet, shared.targetSheet, (ailment, base) =>
        ailmentEventDamage(shared, ailment, base, diagnostics),
      ),
    );
  }

  if (recorder === undefined) return undefined;
  return {
    element,
    depth,
    takenAs,
    baseNumber: amount,
    steps,
    moreMultis,
    finalNumber: dealt,
    penetration: event.penetration,
    children,
  };
}

/**
 * `calculateEffects()` (EffectEvent.java:239-277).
 *
 *     effectsWithCtx.add(CALC_LAYERS_EFFECT);
 *     effectsWithCtx.sort(EffectWithCtx.COMPARATOR);
 *     for (EffectWithCtx item : effectsWithCtx) {
 *         if (item.stat.isNotZero() || item.effect.runsOnZeroStat()) {
 *             item.effect.TryModifyEffect(this, item.statSource, item.stat, item.stat.GetStat());
 *         }
 *     }
 *
 * The flush is a pseudo-stat sitting at priority 30 in the same list, not a step after it —
 * magic shield and ailments depend on the damage being final by the time they run.
 *
 * `EffectWithCtx.compare` returns 0 on equal priority and the underlying collection is a
 * `HashMap`, so the game's order within a band is genuinely unspecified. The engine sorts ties
 * by stat id: a defined order the game does not have is better than an arbitrary one, and it
 * is the only way two runs can be compared at all.
 */
export function sweep(
  ctx: DamageCtx,
  sides: readonly { side: EffectSide; sheet: Sheet }[],
  steps: LayerStep[],
  moreMultis: MoreStep[],
  /**
   * Which `mmorpg_stat` event this is. `on_damage` for a hit; `on_restore_resource` for the
   * once-a-second regen tick, which runs the same layers over a different number.
   */
  eventId: string = ON_DAMAGE,
  /**
   * Whether to queue the layer flush at the end.
   *
   * True for a real event. False for the `on_damage_init` pre-pass, which exists only to let
   * `disable_attacker_stats` answer before the hit's effect list is built — flushing there would
   * spend the layers on a number no layer has written to yet.
   */
  flushLayers = true,
): void {
  type Entry = { priority: number; statId: string; side?: EffectSide; run: () => void };
  const queue: Entry[] = [];

  for (const { side, sheet } of sides) {
    for (const [statId, stat] of sheet) {
      const def = ctx.index.get(statId);

      // Datapack `effect` blocks.
      for (const block of def?.effects ?? []) {
        if (block.side !== side) continue;
        if (!block.events.includes(eventId)) continue;
        if (isZero(stat)) continue;
        queue.push({
          priority: datapackPriority(block.order) ?? UNKNOWN_ORDER_PRIORITY,
          statId,
          side,
          run: () => runBlock(ctx, statId, stat, def?.element, block, side),
        });
      }

      // In-code effects.
      for (const effect of IN_CODE_BY_STAT.get(statId) ?? []) {
        if (effect.side !== side) continue;
        if ((effect.event ?? ON_DAMAGE) !== eventId) continue;
        if (isZero(stat) && !effect.runsOnZero) continue;
        queue.push({
          priority: effect.priority,
          statId,
          side,
          run: () => effect.run(ctx, stat.value, stat.dmgMulti),
        });
      }
    }
  }

  if (flushLayers) {
    queue.push({
      priority: PRIORITY.CALC_DAMAGE_LAYERS,
      statId: " flush",
      run: () => flush(ctx, steps, moreMultis),
    });
  }

  queue.sort((a, b) => (a.priority === b.priority ? a.statId.localeCompare(b.statId) : a.priority - b.priority));

  const recorder = ctx.event.recorder;
  for (const item of queue) {
    if (ctx.event.data.isCanceled()) return;
    // Naming the stat here rather than at each write site is what keeps the breakdown from
    // leaking into every effect signature: a layer write knows who made it because the sweep
    // just said so.
    if (recorder !== undefined) {
      recorder.statId = item.statId;
      recorder.effectId = undefined;
      recorder.side = item.side;
    }
    // An avoided hit zeroes the number; the remaining stats still run, exactly as in game.
    item.run();
  }
  if (recorder !== undefined) {
    recorder.statId = undefined;
    recorder.effectId = undefined;
    recorder.side = undefined;
  }
}

/**
 * `StatData.isNotZero()`, negated.
 *
 *     public boolean isNotZero() {
 *         return v1 != 0 || this.m != 1;
 *     }
 *
 * — StatData.java:64-66, and `EffectEvent.calculateEffects` uses it as the gate on running a
 * stat's effects at all. **Both** halves matter, and the second is the one that bites: a
 * `MULTIPLICATIVE_DAMAGE` stat carries everything it has in `m` and leaves `v1` at zero, so
 * checking the value alone silently dropped every one of them. On the reference build that is
 * `all_fire_damage` at `m = 1.40` against a fire skill — a quarter of the damage, missing, with
 * nothing on screen to say so.
 */
function isZero(stat: EngineStat): boolean {
  return stat.value === 0 && stat.dmgMulti === 1;
}

function runBlock(
  ctx: DamageCtx,
  statId: string,
  stat: EngineStat,
  element: string | undefined,
  block: EffectBlock,
  side: EffectSide,
): void {
  const weight = evaluateIfs(ctx, block.ifs, { statId, value: stat.value, element }, side);
  if (weight <= 0) return;
  const shape = ctx.index.shapeOf(statId);
  for (const effectId of block.effects) {
    if (ctx.event.recorder !== undefined) ctx.event.recorder.effectId = effectId;
    applyStatEffect(
      ctx,
      effectId,
      { statId, value: stat.value, dmgMulti: stat.dmgMulti, multiUseType: shape.multiUseType },
      side,
      weight,
    );
  }
}

/**
 * `calculateStatLayersAndMoreMultis()` (EffectEvent.java:219-237).
 *
 * Layers apply in layer-priority order; every accumulated more-multi then applies
 * unconditionally, after all of them. `appliedFlatDamage` is captured on the way past because
 * ailments read it to reconstruct the pre-multiplier hit.
 */
function flush(ctx: DamageCtx, steps: LayerStep[], moreMultis: MoreStep[]): void {
  const event = ctx.event;
  const recorder = event.recorder;
  if (!event.hasLayers()) return;

  for (const layer of event.sortedLayers()) {
    // Read the accumulator before applying: `CONVERT_PERCENT` spends the conversion budget and
    // queues bonus events as it goes, so afterwards the layer no longer describes what it did.
    const before = event.data.getNumber(EVENT.NUMBER);
    const snapshot =
      recorder === undefined
        ? undefined
        : {
            amount: layer.getNumber(),
            multiplier: layer.layer.action === "MULTIPLY" ? layer.getMultiplier() : undefined,
            conversion: [...layer.normalizedConversion()].map(([element, percent]) => ({
              element,
              percent,
            })),
          };

    applyLayer(ctx, layer);

    if (layer.numberId === EVENT.NUMBER && layer.layer.id === "flat_damage") {
      event.appliedFlatDamage = layer.getNumber();
    }
    if (layer.numberId === EVENT.NUMBER && layer.layer.id === LAYER.DAMAGE_BLOCK) {
      event.hitChance = layer.getMultiplier();
    }
    if (recorder !== undefined && snapshot !== undefined) {
      steps.push({
        layerId: layer.layer.id,
        action: layer.layer.action,
        numberId: layer.numberId,
        side: layer.side,
        amount: snapshot.amount,
        multiplier: snapshot.multiplier,
        conversion: snapshot.conversion,
        additionalTo: layer.additionalTo,
        before,
        after: event.data.getNumber(EVENT.NUMBER),
        contributions: recorder.forLayer(
          layer.layer.id,
          layer.numberId,
          layer.side,
          layer.additionalTo,
        ),
      });
    }
  }

  for (const more of event.moreMultis) {
    const before = event.data.getNumber(more.numberId);
    const after = before * more.multi;
    event.data.setNumber(more.numberId, after);
    if (recorder !== undefined) {
      moreMultis.push({
        statId: more.statId,
        numberId: more.numberId,
        multi: more.multi,
        ...(more.effectId === undefined ? {} : { effectId: more.effectId }),
        before,
        after,
      });
    }
  }
}

/** The five `LayerAction`s (StatLayer.java:50-171). */
function applyLayer(ctx: DamageCtx, layer: ReturnType<DamageEventState["sortedLayers"]>[number]): void {
  const event = ctx.event;
  const data = event.data;

  switch (layer.layer.action) {
    case "ADD":
      data.addNumber(layer.numberId, layer.getNumber());
      return;

    case "MULTIPLY":
      data.setNumber(layer.numberId, data.getNumber(layer.numberId) * layer.getMultiplier());
      return;

    case "CONVERT_PERCENT": {
      // `original` is snapshotted once, before any conversion runs, so two conversions each
      // taking 30% take 30% of the *same* number rather than compounding.
      if (!data.isNumberSetup(EVENT.BEFORE_CONVERSION_NUMBER)) {
        data.setupNumber(EVENT.BEFORE_CONVERSION_NUMBER, data.getNumber(EVENT.NUMBER));
      }
      const original = data.getNumber(EVENT.BEFORE_CONVERSION_NUMBER);
      for (const [element, raw] of layer.normalizedConversion()) {
        let conv = Math.min(raw, 100);
        if (conv > event.unconvertedDamagePercent) conv = event.unconvertedDamagePercent;
        // `return`, not `continue` — the Java aborts the whole loop once the budget runs out.
        if (conv <= 0) return;
        event.unconvertedDamagePercent -= conv;
        const dmg = clampTo((original * conv) / 100, 0, original);
        if (dmg > 0) {
          // `addBonusEleDmg`, not a bare push: converting to the element the hit is already
          // dealt as puts the damage back on this event's `flat_damage` layer rather than
          // spawning a child that would re-sweep the attacker's stats.
          event.addBonusEleDmg(element as ElementName, dmg, layer.side);
          data.addNumber(EVENT.NUMBER, -dmg);
        }
      }
      return;
    }

    case "DAMAGE_TAKEN_AS": {
      const original = data.getNumber(EVENT.NUMBER);
      for (const [element, raw] of layer.normalizedConversion()) {
        // "taking an element as itself changes nothing, and moving it would only lose the
        // damage - this layer runs long after FLAT_DAMAGE was already applied"
        if (element === data.getElement()) continue;
        let conv = Math.min(raw, 100);
        if (conv > event.unconvertedDamageTakenAsPercent) conv = event.unconvertedDamageTakenAsPercent;
        if (conv <= 0) return;
        event.unconvertedDamageTakenAsPercent -= conv;
        const dmg = clampTo((original * conv) / 100, 0, original);
        if (dmg > 0) {
          event.addDamageTakenAsEleDmg(element as ElementName, dmg);
          data.addNumber(EVENT.NUMBER, -dmg);
        }
      }
      return;
    }

    case "X_AS_BONUS_Y_ELEMENT_DAMAGE": {
      const conv = layer.number;
      if (conv <= 0 || layer.additionalTo === undefined) return;
      const dmg = Math.max((data.getNumber(EVENT.NUMBER) * conv) / 100, 0);
      if (dmg > 0) {
        event.addBonusEleDmg(layer.additionalTo as ElementName, dmg, layer.side);
      }
      return;
    }
  }
}

function collectBonusElements(
  ctx: DamageCtx,
  event: DamageEventState,
  shared: Shared,
  crit: boolean,
  depth: number,
  byElement: Map<ElementName, number>,
  ailments: AilmentResult[],
  diagnostics: Diagnostic[],
  restores: RestoreRecord[],
): EventTrace[] {
  const traces: EventTrace[] = [];
  for (const bonus of event.bonusElements) {
    const trace = runEvent(
      shared,
      bonus.element,
      bonus.amount,
      crit,
      depth + 1,
      bonus.takenAs,
      byElement,
      ailments,
      diagnostics,
      // Collected, and folded into the parent's by `runBranch`. The child is its own
      // `DamageEvent` and rolls every proc block again, and an `ele_match_stat` gate can only pass
      // on it: Blade of Desecrated Hallows' Frost Orbs proc on a *cold* hit, and a physical attack
      // it converts is cold only in the bonus event.
      ctx.procs,
      // Leech is the opposite case, and deliberately so: each bonus element is its own
      // `DamageEvent` carrying its own share of the hit, and `ele_match_stat` picks the leech
      // stat that matches *it*. Collecting from the children is how `fire_mana_leech` reaches
      // the fire half of a converted physical hit. A `damage_taken_as` child skips the source
      // sweep entirely (`disableSourceStats`), so it contributes nothing here either way.
      restores,
    );
    if (trace !== undefined) traces.push(trace);
  }
  return traces;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const IN_CODE = inCodeEffects();

/**
 * The same effects keyed on the stat they belong to.
 *
 * The sweep asks "does this stat have an in-code effect?" once per stat per side, and the sheet
 * carries several hundred stats — walking the whole list each time is a six-figure loop for one
 * hit, and the regeneration and leech ticks sweep too. The list never changes, so it is indexed
 * once at module load.
 */
const IN_CODE_BY_STAT = ((): Map<string, typeof IN_CODE> => {
  const map = new Map<string, typeof IN_CODE>();
  for (const effect of IN_CODE) {
    const list = map.get(effect.statId);
    if (list) list.push(effect);
    else map.set(effect.statId, [effect]);
  }
  return map;
})();

/**
 * The declared enemy, as a stat sheet.
 *
 * Every field the document omits reads 0, which is what an undeclared enemy stat means in the
 * game too — an unset stat resolves to `StatData.empty()`.
 */
function enemySheet(enemy: EnemySetup | undefined): Sheet {
  const sheet: Sheet = new Map();
  const put = (statId: string, value: number): void => {
    sheet.set(statId, { value, dmgMulti: 1, hardcap: 0, softcap: 0 });
  };

  // Seeded at 0 whether or not the document mentions them, because the game's `Unit` holds
  // every registered stat and the sweep is driven by that map. `ArmorEffect` and
  // `ElementalResistEffect` both declare `runsOnZeroStat()`, and both *spend* the attacker's
  // penetration — so an undeclared defence is not a defence the attacker gets to skip, it is
  // one worth 0 that still eats penetration. Leaving them out silently discarded it.
  put("armor", 0);
  for (const element of SINGLE_ELEMENTS) put(`${element.guid}_resist`, 0);

  if (!enemy) return sheet;

  if (enemy.armor !== undefined) put("armor", enemy.armor);
  if (enemy.blockChance !== undefined) put("block_chance", enemy.blockChance);
  if (enemy.dodge !== undefined) put("dodge", enemy.dodge);
  // `spell_dodge` is its own stat and its own curve (`valueNeededAtLevelOne: 200`, against
  // dodge's 100), so a spell is evaded by a different number than an attack is. The pack gives
  // every mob both.
  if (enemy.spellDodge !== undefined) put("spell_dodge", enemy.spellDodge);
  if (enemy.damageReduction !== undefined) put("damage_reduction", enemy.damageReduction);
  for (const [guid, value] of Object.entries(enemy.resists ?? {})) put(`${guid}_resist`, value);
  for (const [guid, value] of Object.entries(enemy.maxResists ?? {})) put(`max_${guid}_resist`, value);
  return sheet;
}

/**
 * Debuffs the build is assumed to have put on the mob, folded into its sheet.
 *
 * This is the half of the effect state that moves a damage number: `shred` is `PERCENT -8 armor`
 * stacking to ten, `elemental_weakness` — what the pack calls Scorched — is
 * `FLAT -25 elemental_resist`. Both sit on the *target*, so applying them means editing the
 * enemy's sheet before the mitigation layers read it, not the character's.
 *
 * Two things make this more than an addition.
 *
 * **Modifier types.** `InCalcStatData` resolves `(base + Flat) × (1 + Percent/100) × Multi`, and
 * a debuff that reads `-8%` is a PERCENT — adding its value to an armour of 4000 would take off
 * eight points instead of a fifth. The enemy's declared value stands in for `base`, and the rest
 * is the container's own arithmetic.
 *
 * **Aggregate resists.** The mitigation layers run one effect per *single* element —
 * `fire_resist`, `water_resist`, `lightning_resist` — and skip `Elemental` and `ALL` entirely. A
 * debuff written against `elemental_resist` would land on a stat nothing reads, so it is expanded
 * the way `Elements.getAllSingleElemental()` groups them.
 *
 * **Strength.** A debuff is interpolated and multiplied exactly as a buff is, and reading either
 * at its floor understates it. `EffectOption` already carries both halves, derived once:
 * `rollPercent` from the rank of the spell that applies it — `hunters_mark` is `MORE 7.5..15` on
 * `dmg_received`, a factor of two between a rank-1 and a maxed one — and `strMulti` from your
 * `inc_effect_of_<tag>_buff_given` stats. For a debuff that multiplier is the `_given` half only:
 * the `_on_you` half is the mob's, and in this pack it is `MobRarity.stats`'s single
 * `inc_effect_of_negative_buff_on_you`, which a declared enemy does not carry.
 */
/**
 * The enemy's sheet with everything aimed at it folded in — its affixes and your debuffs.
 *
 * Both in one accumulator on purpose; see {@link applySheetMods}.
 */
function targetSheetFor(
  build: BuildDoc,
  effects: EffectState,
  snapshot: Snapshot,
  index: StatIndex,
  bal: ReturnType<typeof balance>,
  report: (severity: Severity, code: string, path: string, message: string) => void,
  /** Filled in with where each modified stat came from, when a caller wants to explain one. */
  origins?: Map<string, TargetStatOrigin>,
): Sheet {
  const sheet = enemySheet(build.config?.enemy);
  const affixIds = build.config?.enemy?.affixes ?? [];
  // `Load.Unit(en).getLevel()` — the mob's own level, which falls back to the character's when
  // the document does not say, the same way every other enemy field does.
  const mobLevel =
    build.config?.enemy?.level ?? build.config?.enemyLevel ?? build.character.level;

  // Through `targetStats` like a debuff's: `of_elemental_resistance` writes `elemental_resist`,
  // which no mitigation effect reads — the aggregate has to be handed to the elements it covers
  // or the affix moves nothing at all.
  const affixes = mobAffixMods(snapshot, index, bal, mobLevel, affixIds, report).flatMap((m) =>
    spreadsTo(m.statId).map((statId) => ({
      statId,
      type: m.type,
      value: m.value,
      source: m.source,
      path: "config.enemy.affixes",
    })),
  );
  for (const d of mobAffixDiagnostics(snapshot, affixIds)) report(d.severity, d.code, d.path, d.message);

  // The map's `Mobs` affixes and its tier, which every mob in it carries on top of its own — see
  // `damage/map.ts`. Same accumulator as the affixes above, because the game sums them in one
  // container: `fire_res 45` from the map and `of_elemental_resistance` from the mob meet there.
  const fromMap = mapMobMods(snapshot, index, bal, build.config?.map, mobLevel, report).flatMap((m) =>
    spreadsTo(m.statId).map((statId) => ({
      statId,
      type: m.type,
      value: m.value,
      source: m.source,
      path: "config.map",
    })),
  );

  const mods = [
    ...affixes,
    ...fromMap,
    ...debuffMods(effects, snapshot, index, bal, build.character.level),
  ];

  // Captured before the mods are folded in, because that is the only moment the enemy's own
  // declared value still exists — `applySheetMods` overwrites it in place.
  if (origins !== undefined) {
    for (const mod of mods) {
      let origin = origins.get(mod.statId);
      if (origin === undefined) {
        origin = {
          statId: mod.statId,
          declared: sheet.get(mod.statId)?.value ?? 0,
          mods: [],
          final: 0,
        };
        origins.set(mod.statId, origin);
      }
      origin.mods.push(mod);
    }
  }

  applySheetMods(sheet, mods, index, report);

  if (origins !== undefined) {
    for (const origin of origins.values()) {
      origin.final = sheet.get(origin.statId)?.value ?? 0;
    }
  }
  return sheet;
}

function debuffMods(
  effects: EffectState,
  snapshot: Snapshot,
  index: StatIndex,
  bal: ReturnType<typeof balance>,
  level: number,
): TargetMod[] {
  const out: TargetMod[] = [];

  for (const option of activeOn(effects, "target")) {
    const data = entry(snapshot, CATEGORY.exileEffect, option.id)?.data;
    const raw = data?.["stats"];
    if (!Array.isArray(raw)) continue;

    for (const mod of parseRolledMods(raw as Record<string, unknown>[])) {
      const exact = rollToExact(mod, option.rollPercent, level, index.shapeOf(mod.statId), bal);
      // `stacks_affect_stats` multiplies the value by the stack count — `increaseByAddedPercent`
      // with `(stacks - 1) * 100`, which is exactly `× stacks`.
      const stacked =
        data?.["stacks_affect_stats"] === true && option.stacks > 1
          ? multiplyExact(exact, option.stacks)
          : exact;
      // `ExileEffectInstanceData.str_multi`, the same factor `collectExileEffects` applies to a
      // buff. A character stacked into "increased effect of negative buffs given" really does
      // shred harder, and until now that stat changed nothing.
      const scaled = option.strMulti === 1 ? stacked : multiplyExact(stacked, option.strMulti);

      for (const statId of spreadsTo(scaled.statId)) {
        out.push({ statId, type: scaled.type, value: scaled.value, source: option.id, path: "config.effects" });
      }
    }
  }
  return out;
}

/** One resolved modifier bound for the enemy's sheet, with what produced it. */
export type TargetMod = { statId: string; type: ModType; value: number; source: string; path: string };

/**
 * How one stat on the enemy arrived at the number a mitigation layer read.
 *
 * The enemy's sheet is not the character's, and until this existed there was no way to ask it
 * anything. A breakdown could name the *stat* behind `Elemental Mitigation x1.20` and stop
 * there — and stopping there is exactly where the question starts, because the number the layer
 * used is rarely the number the target preset declared. A mythic mob's 30 cold resistance is
 * 13.61 by the time a build carrying Banner of the Piercing Gale has hit it, and 30 − 33.61
 * penetration does not equal what the panel showed.
 *
 * `declared` is what the preset or the document said; `mods` is everything aimed at it, in the
 * order it was applied; `final` is what the sweep actually read.
 */
export type TargetStatOrigin = {
  statId: string;
  /** The enemy's own value before any affix or debuff — `config.enemy`, or 0. */
  declared: number;
  /** Mob affixes and your debuffs, each with the id that granted it. */
  mods: TargetMod[];
  /** What the mitigation layers saw. */
  final: number;
};

/**
 * Everything aimed at the enemy, folded into its sheet in one pass.
 *
 * One pass rather than one per source, because the container does not apply contexts in turn:
 * `InCalcStatData.calcValue` is `(base + Flat) × (1 + Percent/100) × Multi` over the *sum* of
 * every context that touched the stat. A mob affix granting `MORE 20 accuracy` and a debuff
 * granting `PERCENT -8 armor` have to meet in the same accumulator or the arithmetic is a
 * different one.
 */
export function applySheetMods(
  sheet: Sheet,
  mods: readonly TargetMod[],
  index: StatIndex,
  report: (severity: Severity, code: string, path: string, message: string) => void,
): void {
  // Which source wrote to a stat, so one that turns out to change nothing can be named.
  const wroteTo = new Map<string, { source: string; path: string }>();
  const pending = new Map<string, { flat: number; percent: number; multi: number }>();

  for (const mod of mods) {
    let into = pending.get(mod.statId);
    if (!into) {
      into = { flat: 0, percent: 0, multi: 1 };
      pending.set(mod.statId, into);
    }
    wroteTo.set(mod.statId, { source: mod.source, path: mod.path });
    if (mod.type === "FLAT") into.flat += mod.value;
    else if (mod.type === "PERCENT") into.percent += mod.value;
    else into.multi *= 1 + mod.value / 100;
  }

  for (const [statId, mods2] of pending) {
    const mods = mods2;
    const shape = index.shapeOf(statId);
    const current = sheet.get(statId);
    // The declared enemy stat stands in for `Stat.base`: an undeclared defence is 0, which is
    // what `StatData.empty()` gives and what `enemySheet` already seeds.
    let value = (current?.value ?? 0) + mods.flat;
    value *= 1 + mods.percent / 100;
    if (shape.multiUseType === "MULTIPLY_STAT") value *= mods.multi;
    // The other half of `InCalcStatData`: on a `MULTIPLICATIVE_DAMAGE` stat, MORE is not folded
    // into the value at all but kept as the stat's damage multiplier, which the damage effect
    // spends as its own MORE line. A map tier's `MORE total_damage` on a mob with no flat
    // `total_damage` is exactly this, and dropping it here lost the whole tier.
    const damageMulti = shape.multiUseType === "MULTIPLICATIVE_DAMAGE" ? mods.multi : 1;

    // `InCalcStatData.calcValue` is `(base + Flat) × (1 + Percent/100) × Multi`, and MORE feeds
    // only `Multi` — so a MORE modifier on a stat whose base and flat are both zero multiplies
    // zero and produces zero. That is the game's arithmetic, not a shortcut taken here, and it
    // makes a debuff that reads as a large effect worth literally nothing. `hunters_mark` is the
    // one that matters: `MORE 7.5..15 dmg_received`, and `dmg_received` has `base: 0`, so
    // marking a mob changes no number at all unless something else has already given it some.
    if (mods.multi !== 1 && damageMulti === 1 && (current?.value ?? 0) + mods.flat === 0) {
      report(
        "warning",
        "debuff-more-on-zero-base",
        wroteTo.get(statId)?.path ?? "config.effects",
        `\`${wroteTo.get(statId)?.source ?? "a debuff"}\` modifies \`${statId}\` by MORE, and the target's ` +
          `\`${statId}\` is 0. \`InCalcStatData\` folds MORE into a multiplier over ` +
          `\`(base + flat) × (1 + percent/100)\`, so it multiplies zero: the debuff changes ` +
          `nothing, in the engine and in the game alike. Give the enemy a non-zero \`${statId}\` ` +
          `if you are modelling a mob that has one.`,
      );
    }

    sheet.set(statId, {
      value: Math.min(Math.max(value, shape.min), shape.max),
      dmgMulti: (current?.dmgMulti ?? 1) * damageMulti,
      hardcap: current?.hardcap ?? 0,
      softcap: current?.softcap ?? 0,
    });
  }
}

/**
 * Which stats a modifier written against an aggregate really lands on.
 *
 * Every damage layer is registered per *single* element — `fire_resist`, `water_penetration` —
 * and the aggregates are not layers at all. In a real calculation that is fine, because
 * `ITransferToOtherStats` empties `elemental_resist` into its three elements before the first
 * pass and clears itself (`applyTransfers` in `calculate.ts`). A sheet assembled by hand never
 * ran that pass, so on those an aggregate is an id nothing reads and the modifier is silently
 * worth nothing.
 *
 * Driven by `CODE_ONLY_TRANSFERS` rather than by a list written here, which is the fix for the
 * bug that prompted this: the hand-written version covered `elemental_resist` and `all_resist`
 * and nothing else, so the `penetrating` mob affix's `elemental_penetration 25` reached none of
 * your three elemental resists — its `armor_penetration` and `chaos_penetration` were real ids
 * and did apply, which is exactly the "physical and chaos move, the elements do not" shape it
 * showed up as. The generated table is the game's own `ITransferToOtherStats` and covers the
 * whole family: both penetrations, both conversions, `phys_taken_as_elemental` and the two
 * resist aggregates.
 *
 * `all_resist` stays hardcoded because it is not an `ITransferToOtherStats` at all — the ALL
 * element spreads through `Elements.multi`, a different mechanism — and dropping it here would
 * silently un-fix a case that already worked.
 */
function spreadsTo(statId: string): readonly string[] {
  if (statId === "all_resist") return SINGLE_ELEMENTS.map((e) => `${e.guid}_resist`);
  return CODE_ONLY_TRANSFERS[statId] ?? [statId];
}

/**
 * The same, for a sheet that is not the target's.
 *
 * Exported for `defence.ts`, which builds the *attacker's* sheet by hand from a mob's affixes
 * and hit the identical problem from the other side.
 */
export function aggregateSpread(statId: string): readonly string[] {
  return spreadsTo(statId);
}

/** The first `damage` act found anywhere in the spell's component tree. */
function damageAct(
  spell: Record<string, unknown>,
  options: DamageOptions,
): { element: ElementName; valueCalcId: string } | undefined {
  if (options.valueCalcId !== undefined && options.element !== undefined) {
    return { element: options.element, valueCalcId: options.valueCalcId };
  }

  let found: { element: ElementName; valueCalcId: string } | undefined;
  const visit = (node: unknown): void => {
    if (found) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = asObject(node);
    if (!obj) return;
    if (obj["type"] === "damage") {
      const map = asObject(obj["map"]) ?? {};
      const element = typeof map["element"] === "string" ? map["element"] : "Physical";
      found = {
        element: element in ELEMENTS ? (element as ElementName) : "Physical",
        valueCalcId: typeof map["value_calculation"] === "string" ? map["value_calculation"] : "",
      };
      return;
    }
    for (const value of Object.values(obj)) visit(value);
  };
  visit(spell["attached"]);
  return found;
}

function mainSkill(build: BuildDoc, report: (s: Severity, c: string, p: string, m: string) => void): SkillSetup | undefined {
  const skills = build.skills ?? [];
  const marked = skills.find((s) => s.main === true);
  if (marked) return marked;
  if (skills.length > 1) {
    report(
      "warning",
      "no-main-skill",
      "skills",
      `${skills.length} skills are declared and none is marked \`main\`, so \`${skills[0]?.spellId}\` was used.`,
    );
  }
  return skills[0];
}

function spellTags(spell: Record<string, unknown>): Set<string> {
  const config = asObject(spell["config"]);
  const tagsNode = asObject(config?.["tags"]);
  const list = tagsNode?.["tags"];
  return new Set(Array.isArray(list) ? list.filter((t): t is string => typeof t === "string") : []);
}

/**
 * One swing of the weapon in your hand.
 *
 * `WeaponMechanic.doNormalAttack` is four lines and every one of them matters:
 *
 *     int num = (int) data.getAttackerEntityData().getUnit()
 *             .getCalculatedStat(WeaponDamage.getInstance()).getValue();
 *     DamageEvent dmg = EventBuilder.ofDamage(data, attacker, target, num)
 *             .setupDamage(AttackType.hit, weptype, data.weaponData.GetBaseGearType().style)
 *             .setIsBasicAttack()
 *             .build();
 *     dmg.Activate();
 *
 * So a basic attack is not a special pipeline. It is the *same* `DamageEvent` a spell raises,
 * with three differences: the base is the `weapon_damage` stat truncated to an int rather than a
 * `value_calculation`; `dmg_effectiveness` is 1, because nothing scales it; and the sheet it
 * sweeps is the **character unit**, not a spell unit — there is no spell, so there are no
 * support gems and no `statsForSkillGem`.
 *
 * `EventData.SPELL` is left empty for the same reason, which is what makes every `spell_has_tag`
 * gate correctly fail on a swing.
 */
export function simulateBasicAttack(
  build: BuildDoc,
  snapshot: Snapshot,
  options: DamageOptions = {},
): DamageResult | undefined {
  const diagnostics: Diagnostic[] = [];
  const report = (severity: Severity, code: string, path: string, message: string): void => {
    diagnostics.push({ severity, code, path, message });
  };

  const index = statIndex(snapshot);
  const layers = layerIndex(snapshot);
  const bal = balance(snapshot, options.balanceId);
  const compat = options.compat ?? ORIGINAL_MODE;

  const sheetOptions = {
    ...pick(options),
    ...(options.effects === undefined ? {} : { effects: options.effects }),
  };
  const characterRun = options.sheets?.character ?? calculate(build, snapshot, sheetOptions);
  const characterSheet = characterRun.stats;
  const effects = options.effects ?? characterRun.effects;
  const targetOrigins = new Map<string, TargetStatOrigin>();
  const targetSheet = targetSheetFor(build, effects, snapshot, index, bal, report, targetOrigins);

  // `(int)` on the stat value, toward zero, exactly as the Java casts it.
  const baseValue = Math.trunc(sheetValue(characterSheet, "weapon_damage"));
  if (baseValue <= 0) {
    report(
      "info",
      "no-weapon-damage",
      "gear",
      "This build's `weapon_damage` is zero, so a basic attack deals nothing. It is the stat a " +
        "weapon's own damage roll lands on, so a character holding no weapon reads zero here.",
    );
  }

  // `AttackType.hit`, `Elements.Physical` — a swing's element is the weapon's, and every weapon
  // in this pack rolls physical. Conversion stats move it afterwards like any other hit.
  const element: ElementName = options.element ?? "Physical";
  const critChance = clamp01(sheetValue(characterSheet, "critical_hit") / 100);

  const shared: Shared = {
    snapshot,
    index,
    layers,
    balance: bal,
    compat,
    build,
    // No spell: `getSpellData("")` is how the game's own empty `InsertedSpell` reads, and an
    // empty id is what makes `spell_has_tag_*` and `is_spell` answer false.
    skill: { spellId: "" },
    spell: {},
    sourceSheet: characterSheet,
    targetSheet,
    baseValue,
    // `dmg_effectiveness` is a `value_calculation` field and a swing has no value calculation.
    effectiveness: 1,
    element,
    effects,
    breakdown: options.breakdown === true,
    basicAttack: true,
    summonAttack: false,
    style: playStyle(snapshot, build),
    // A swing always lands on something else; nothing in the pack makes you hit yourself with one.
    selfHit: false,
    sourceStatsDisabled: false,
    hitChance: 1,
  };

  const procs = options.procs === true ? { onHit: [] as ProcHit[], onCrit: [] as ProcHit[] } : undefined;
  const hit = runBranch(shared, false, diagnostics, procs?.onHit);
  const crit = runBranch(shared, true, diagnostics, procs?.onCrit);

  return {
    spellId: "",
    baseValue,
    dmgEffectiveness: 1,
    element,
    critChance,
    // A swing is `AttackType.hit` and not a `magic` spell, which is exactly what `DodgeRating`
    // takes, so against a mob with dodge the figure is routinely below 1.
    hitChance: shared.hitChance,
    selfHit: false,
    hit,
    crit,
    average: blend(hit, crit, critChance),
    // Both halves are the character sheet: a swing has no spell unit, and handing back a second
    // reference to the same run is more honest than inventing one.
    sheets: { character: characterRun, spell: characterRun },
    target: { sheet: targetSheet, origins: targetOrigins },
    ...(procs === undefined ? {} : { procs }),
    diagnostics,
  };
}

/**
 * The ailment's own `DamageEvent`, run purely to arrive at a number.
 *
 *     EventBuilder.ofDamage(source, target, dmg)
 *             .setupDamage(AttackType.dot, WeaponTypes.none, PlayStyle.INT)
 *             .set(x -> { x.disableActivation = true;
 *                         x.setElement(ailment.element);
 *                         x.setisAilmentDamage(ailment);
 *                         if (spell != null) x.data.setString(EventData.SPELL, spell.GUID()); })
 *
 * — AilmentChance.activate. Everything about its shape is the builder's, not the hit's, and each
 * of those differences changes which stats it picks up:
 *
 *  - **`AttackType.dot`** — nothing gated on a hit applies, and `AilmentChance.canActivate`
 *    refuses it, so an ailment can never inflict an ailment. That is the recursion guard, and it
 *    is the game's rather than one invented here.
 *  - **`WeaponTypes.none` and `PlayStyle.INT`** — written as literals. A greatsword build's
 *    ailments are `int`, which is what stops the thirteen `style_is_int_is_false` stats
 *    (`attack_damage`, the three leeches, the four attack procs) from reaching a DoT.
 *  - **No crit.** The builder never sets it, so the pinned branch does not carry over; an
 *    ailment inflicted by a crit is the same size as one inflicted by a normal hit.
 *
 * Both sides are swept, because `Activate()` is the whole pipeline: the target's mitigation
 * layers apply here, and `<ailment>_resistance` applies again afterwards in
 * `onAilmentCausingDamage`. Both, in that order, is what the game does.
 *
 * A trace is recorded when one was asked for, because the game prints this event as its own
 * block in the damage log and the rows are the whole point: the ailment's `additive_damage` is a
 * different number from the hit's — `dot`/`int` against `hit`/the weapon's style — and only a
 * row-by-row reading says which stats crossed over and which did not. It is still off by default,
 * so the ordinary path allocates nothing.
 */
function ailmentEventDamage(
  shared: Shared,
  ailment: Ailment,
  base: number,
  diagnostics: Diagnostic[],
): AilmentEvent {
  if (base <= 0) return { damage: 0 };

  const recorder = shared.breakdown ? new Recorder() : undefined;
  const event = new DamageEventState(shared.layers, undefined, recorder);
  event.data.setupNumber(EVENT.NUMBER, base);
  // A `value_calculation`'s field, and this event has no value calculation.
  event.data.setupNumber(EVENT.DMG_EFFECTIVENESS, 1);
  event.data.setString(EVENT.ELEMENT, ailment.element);
  event.data.setString(EVENT.ATTACK_TYPE, "dot");
  event.data.setString(EVENT.WEAPON_TYPE, "none");
  event.data.setString(EVENT.STYLE, "int");
  event.data.setString(EVENT.SPELL, shared.skill.spellId);
  event.data.setString(EVENT.AILMENT, ailment.id);

  const ctx: DamageCtx = {
    snapshot: shared.snapshot,
    index: shared.index,
    balance: shared.balance,
    compat: shared.compat,
    event,
    source: shared.sourceSheet,
    target: shared.targetSheet,
    sourceLevel: shared.build.character.level,
    targetLevel:
      shared.build.config?.enemy?.level ??
      shared.build.config?.enemyLevel ??
      shared.build.character.level,
    spell: shared.spell,
    spellId: shared.skill.spellId,
    spellTags: spellTags(shared.spell),
    config: shared.build.config ?? {},
    effects: shared.effects,
    diagnostics,
    report: (severity, code, path, message) => diagnostics.push({ severity, code, path, message }),
    reportedConditions: new Set(),
    reportedEffects: new Set(),
    pinnedBooleans: new Set([EVENT.CRIT]),
    disableSourceStats: false,
    // Carried from the hit that caused it: an ailment off a self-hit is one you gave yourself,
    // and its own sweep reads the same sheets on the same two sides.
    sourceIsTarget: shared.selfHit,
    sourceDualWielding: isDualWielding(shared.snapshot, shared.build.gear ?? []),
    ...(shared.selfHit ? { targetDualWielding: isDualWielding(shared.snapshot, shared.build.gear ?? []) } : {}),
  };

  const steps: LayerStep[] = [];
  const moreMultis: MoreStep[] = [];
  sweep(
    ctx,
    [
      { side: "Source" as const, sheet: shared.sourceSheet },
      { side: "Target" as const, sheet: shared.targetSheet },
    ],
    steps,
    moreMultis,
  );

  const damage = Math.max(0, event.damage);
  if (recorder === undefined) return { damage };
  return {
    damage,
    trace: {
      element: ailment.element,
      // Its own event, not a child of the hit's: `AilmentChance.activate` builds it from the
      // source and target rather than from the hit, so nothing about it is nested.
      depth: 0,
      takenAs: false,
      baseNumber: base,
      steps,
      moreMultis,
      finalNumber: damage,
      penetration: event.penetration,
      // An ailment event cannot spawn bonus elements: `addBonusEleDmg` is reached only from
      // effects gated on a direct hit, and this one is `dot`.
      children: [],
    },
  };
}

/** `spell.config.style` — already `PlayStyle.id` in the snapshot, so lower case throughout. */
function spellStyle(spell: Record<string, unknown>): string {
  const config = asObject(spell["config"]);
  const style = config?.["style"];
  return typeof style === "string" ? style.toLowerCase() : "";
}

/**
 * `PlayStyle.id` of the mainhand's base gear type — `str`, `dex` or `int`.
 *
 * `setupDamage` takes it from `data.weaponData.GetBaseGearType().style` on a basic attack and
 * from the spell's own config on a cast. The snapshot spells the gear type's `STR`; `PlayStyle.id`
 * is its lower case, which is what every `string_matches` on `style` compares against.
 */
function playStyle(snapshot: Snapshot, build: BuildDoc): string {
  for (const item of build.gear ?? []) {
    if (item.offhand === true) continue;
    const base = entry(snapshot, CATEGORY.baseGearType, item.base)?.data;
    const type = base?.["weapon_type"];
    if (typeof type !== "string" || type.length === 0 || type === "none") continue;
    const style = base?.["style"];
    if (typeof style === "string" && style.length > 0) return style.toLowerCase();
  }
  return "";
}

/** `EventData.WEAPON_TYPE`, set from the held weapon when the spell uses one. */
/**
 * The id the weapon multiplier is recorded under.
 *
 * Not a `mmorpg_stat` — the game passes a `Words` entry rather than a stat, because this is a
 * property of the weapon's slot and nothing on a sheet. It still has to be *named*, because the
 * damage log prints it as its own row and a breakdown that cannot say where a 1.6 came from is
 * the thing the trace exists to prevent.
 */
export const WEAPON_BASIC_ATTACK_MULTI = "weapon_basic_attack_dmg_multi";

/**
 * `GearSlot.getBasicDamageMulti()` for the weapon in hand, or `undefined` when unarmed.
 *
 * The same walk as {@link weaponType} and for the same reason: a build document has no "mainhand"
 * field, so the weapon is whichever equipped item has a weapon slot and is not flagged `offhand`.
 * The first match wins, which is what the game does too — a swing uses the mainhand.
 */
function basicAttackWeaponMulti(shared: Shared): number | undefined {
  for (const item of shared.build.gear ?? []) {
    if (item.offhand === true) continue;
    const base = entry(shared.snapshot, CATEGORY.baseGearType, item.base)?.data;
    const slotId = base?.["gear_slot"];
    if (typeof slotId !== "string" || slotId.length === 0) continue;
    const slot = entry(shared.snapshot, CATEGORY.gearSlot, slotId)?.data;
    const weaponData = slot?.["weapon_data"];
    if (weaponData === null || typeof weaponData !== "object" || Array.isArray(weaponData)) continue;
    const multi = (weaponData as Record<string, unknown>)["damage_multiplier"];
    // A zero multiplier is every non-weapon slot, so it is "not a weapon" rather than "a weapon
    // that deals nothing" — skip and keep looking rather than returning 0 and zeroing the swing.
    if (typeof multi === "number" && multi > 0) return multi;
  }
  return undefined;
}

function weaponType(shared: Shared): string {
  for (const item of shared.build.gear ?? []) {
    if (item.offhand === true) continue;
    const base = entry(shared.snapshot, CATEGORY.baseGearType, item.base)?.data;
    const type = base?.["weapon_type"];
    if (typeof type === "string" && type.length > 0 && type !== "none") return type;
  }
  return "none";
}

/** Weighted mean of the two branches. Elements are blended individually so the split survives. */
function blend(hit: HitOutcome, crit: HitOutcome, critChance: number): HitOutcome {
  const byElement = new Map<ElementName, number>();
  for (const element of new Set([...hit.byElement.keys(), ...crit.byElement.keys()])) {
    const a = hit.byElement.get(element) ?? 0;
    const b = crit.byElement.get(element) ?? 0;
    byElement.set(element, a * (1 - critChance) + b * critChance);
  }
  let total = 0;
  for (const amount of byElement.values()) total += amount;
  return {
    total,
    byElement,
    ailments: blendAilments(hit.ailments, crit.ailments, critChance),
    restores: blendRestores(hit.restores, crit.restores, critChance),
  };
}

/**
 * The two branches' ailments, weighted the same way the damage is.
 *
 * Keyed on the ailment rather than positionally, for the reason {@link blendRestores} is: the
 * crit branch can reach a block the non-crit one does not — anything gated on `is_crit` — so the
 * two lists are not parallel, and a crit-only ailment lined up against the wrong slot or fell off
 * the end.
 *
 * Every number that scales with the hit is weighted, not just `damagePerSecond`. Weighting one
 * and carrying the rest from whichever branch happened to be first is what put
 * "565/s for 3s = 1697" on the Average card with the three numbers not multiplying out — the
 * per-second figure blended and the total beside it the non-crit branch's.
 *
 * `chance` and `durationSeconds` are properties of the ailment rather than of the hit —
 * `<ailment>_chance` and the duration stat are read off the same sheet in both branches — so
 * they are taken from whichever branch has the row rather than averaged.
 */
function blendAilments(
  hit: readonly AilmentResult[],
  crit: readonly AilmentResult[],
  critChance: number,
): AilmentResult[] {
  const merged = new Map<string, AilmentResult>();
  const fold = (results: readonly AilmentResult[], weight: number): void => {
    for (const result of results) {
      const found = merged.get(result.ailment);
      if (found) {
        found.damagePerSecond += result.damagePerSecond * weight;
        found.totalDamage += result.totalDamage * weight;
        found.accumulated += result.accumulated * weight;
      } else {
        merged.set(result.ailment, {
          ...result,
          damagePerSecond: result.damagePerSecond * weight,
          totalDamage: result.totalDamage * weight,
          accumulated: result.accumulated * weight,
        });
      }
    }
  };
  fold(hit, 1 - critChance);
  fold(crit, critChance);
  return [...merged.values()];
}

/**
 * The two branches' leech, weighted the same way the damage is.
 *
 * Keyed on stat and resource rather than positionally: the crit branch can reach a block the
 * non-crit one does not (anything gated on `is_crit`), so the lists are not parallel. A record
 * present in only one branch is carried at its own branch's weight, which is the whole point —
 * crit-only leech should read as `chance × amount`, not as the full amount.
 */
function blendRestores(
  hit: readonly RestoreRecord[],
  crit: readonly RestoreRecord[],
  critChance: number,
): RestoreRecord[] {
  const merged = new Map<string, RestoreRecord>();
  const fold = (records: readonly RestoreRecord[], weight: number): void => {
    for (const record of records) {
      const key = `${record.statId}|${record.effectId}|${record.resource}|${record.restoreType}`;
      const found = merged.get(key);
      if (found) found.amount += record.amount * weight;
      else merged.set(key, { ...record, amount: record.amount * weight });
    }
  };
  fold(hit, 1 - critChance);
  fold(crit, critChance);
  return [...merged.values()];
}

function envOf(
  base: { snapshot: Snapshot; balance: ReturnType<typeof balance>; level: number },
  index: StatIndex,
  bal: ReturnType<typeof balance>,
): Parameters<typeof spellLevel>[0] {
  return {
    snapshot: base.snapshot,
    index,
    balance: bal,
    level: base.level,
    diagnostics: [],
    report: () => {},
  };
}

function pick(options: DamageOptions): { balanceId?: string; baseStatsId?: string } {
  return {
    ...(options.balanceId === undefined ? {} : { balanceId: options.balanceId }),
    ...(options.baseStatsId === undefined ? {} : { baseStatsId: options.baseStatsId }),
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function clampTo(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function clamp01(value: number): number {
  return clampTo(value, 0, 1);
}
