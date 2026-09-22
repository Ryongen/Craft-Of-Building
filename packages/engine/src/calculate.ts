/**
 * The calculation, in the order `StatCalculation.calc` runs it (StatCalculation.java:58-161).
 *
 * The order is the whole thing. Every individual step is a couple of lines of arithmetic; what
 * makes a stat sheet come out right or wrong is when each runs relative to the others — which
 * pass a stat reads its inputs from, and which snapshot of the container it reads them out of.
 *
 * Scope is the character sheet, which is the no-spell path: `getStatsWithoutSuppGems` followed
 * by `calc(unit, stats, entity, null, -1)`. Support-gem and innate-spell contexts exist in the
 * game's version of this and are deliberately absent here — they belong to a chosen spell, not
 * to the character.
 */

import type { BuildDoc, Diagnostic, SkillSetup } from "@cte2/schema";
import {
  DEFAULT_PLAYER_BASE_STATS_ID,
  isAuraEnabled,
  offhandWeaponCounts,
  supportLinks,
  wornItems,
} from "@cte2/schema";
import type { Snapshot } from "@cte2/extractor";

import { balance } from "./balance.js";
import {
  CTX_MODIFIERS,
  BLOCK_BASE_CAP,
  RESIST_BASE_CAP,
  RESIST_HARD_CAP,
  USABLE_STATS,
} from "./code-only-behaviour.js";
import { collectBaseStats } from "./collect/base-stats.js";
import { collectAuras, collectExileEffects, collectFoodBuffs } from "./collect/effects.js";
import { collectGear, collectJewels } from "./collect/gear.js";
import { collectItemSets } from "./collect/item-sets.js";
import { collectNewbieResists } from "./collect/newbie-resists.js";
import { collectOmen } from "./collect/omen.js";
import { collectPerks } from "./collect/perks.js";
import { collectSpellSchools } from "./collect/spell-schools.js";
import { collectStatCompat } from "./collect/stat-compat.js";
import { collectStatPoints } from "./collect/stat-points.js";
import { collectSpellContexts, withLearnedRank, type SpellRanks } from "./collect/spell.js";
import { NO_EFFECTS, activeOn, resolveEffectState, type EffectState } from "./damage/effect-state.js";
import { InCalcContainer, clamp, type StatContainer } from "./container.js";
import { context, makeEnv, type StatContext } from "./context.js";
import { levelScale, type ExactMod, type ModType } from "./modifier.js";
import { statIndex, type StatDef, type StatIndex } from "./stat-def.js";

export type EngineOptions = {
  balanceId?: string;
  baseStatsId?: string;
  /**
   * The skill to build the stat unit *for*.
   *
   * Omitted, this is `calc(unit, stats, entity, null, -1)` — the character sheet, exactly as
   * phase 1 computed it. Supplied, it is `getSpellUnitStats(spell)`: the same calculation with
   * the spell's innate stats and its linked support gems added on top. The game keeps both,
   * one per spell, and they are genuinely different sheets — a support gem's "+30% fire
   * damage" is real for one skill and absent for every other.
   */
  skill?: SkillSetup;
  /**
   * The ranks `SpellCastingData.calcSpellLevels` resolved, for an unstated `skill.level`.
   *
   * Bonus ranks are stats (`MaxSpellLevel`, `MaxAllSpellLevels`), so they are only known once a
   * sheet exists — which is why they arrive as an option rather than being derived here. The
   * game runs in exactly this order: `calcStats` builds the character unit, then hands it to
   * `calcSpellLevels`, and only afterwards is any spell's own unit built. Omitted, an unstated
   * rank falls back to the `learn_<id>` the document alone can be read for.
   */
  spellRanks?: SpellRanks;
  /**
   * `CompatConfig.get().healthSystem().addBonusHealthFromVanillaHearts()` — the gate on adding
   * the player's vanilla max health into the MnS health pool.
   *
   * A Forge config like `newbieResists`, so no snapshot reports it. It defaults to **on**,
   * which is what the captures show: a fresh level 1 reads health 100 against a base of 80,
   * and vanilla's own max health is 20.
   */
  vanillaHealth?: boolean;
  /**
   * `CompatConfig.get().newbieResists()` — the gate on the free elemental resists a character
   * starts with (see `collect/newbie-resists.ts`).
   *
   * It is a Forge config rather than a datapack entry, so no snapshot can report it and there
   * is nothing to read it from. It defaults to **on**, which is the only setting both captured
   * fixtures reconcile with. Set it false to model a pack that disabled it — and in tests that
   * assert on raw resist numbers, where the grant is noise rather than the subject.
   */
  newbieResists?: boolean;
  /**
   * Which exile effects are up, already resolved.
   *
   * Supply it whenever the caller has a state of its own — `simulateDps` does, because the
   * damage gates, the mob's debuffs and the stat sheet all have to be describing the same
   * character. Omitted, this resolves one; and because resolving reads the finished sheet
   * (`max_<id>_charges`, the `give_exile_effect` stats, the `inc_effect_of_*` buff strengths)
   * it does so from a first pass with no effects applied, then runs the real one on top.
   *
   * {@link NO_EFFECTS} is how that first pass is expressed, and is also how a caller asks for a
   * sheet with no buffs on it at all.
   */
  effects?: EffectState;
  /**
   * The Dual-Wield Effectiveness an offhand weapon's share is computed with.
   *
   * Internal: `calculate` settles it itself when an offhand weapon is worn (see
   * {@link settleDualWield}), and a caller has no better value to offer.
   */
  dualWieldEffectiveness?: number;
};

/** `Mth.clamp(entity.getMaxHealth(), 0, 500)` — the ceiling on what vanilla hearts contribute. */
const VANILLA_HEALTH_CAP = 500;

/** What the engine knows about one stat. A superset of `@cte2/schema`'s `ComputedStat`. */
export type EngineStat = {
  value: number;
  dmgMulti: number;
  /** `Stat.getHardCap()`; the GUI prints "Inf" for anything at `MAX_FLOAT`. */
  hardcap: number;
  /** `Stat.getDefaultSoftCap()`. 0 for every stat as the mod currently ships. */
  softcap: number;
  /**
   * `IUsableStat.getUsableValue`, as the percentage the sheet prints rather than the fraction
   * the method returns — the GUI renders `getUsableValue(...) * 100F`. Only the four
   * `IUsableStat` stats have one.
   */
  usableValue?: number;
};

/**
 * A contribution the calculation itself produced, rather than one a collector gathered.
 *
 * `contexts` covers step 1 only: what gear, perks, auras and base stats handed in. Steps 6 and
 * 8 add more — a core stat granting its bundle, an `one_to_other` emptying a percentage of its
 * adder into a third stat — and those land straight in the container. Without this, a
 * breakdown reconstructed from `contexts` silently omits exactly the stats attributes and
 * conversions feed, which is most of what a caster's damage is made of.
 *
 * Kept separate from `contexts` rather than appended to it: `StatContext.type` is the game's
 * own `StatCtxType`, and these are not contexts in that sense — nothing can modify them as a
 * group, which is the entire reason contexts exist.
 */
export type DerivedContribution = {
  kind:
    | "transfer"
    | "core_stat"
    | "bonus_stat_per_effect"
    | "one_to_other"
    | "more_x_per_y"
    /** `InCalc.addVanillaHpToStats` — the player's vanilla hearts, added to the health pool. */
    | "vanilla-health";
  /** The stat that produced it — `elemental_resist`, `dexterity`, `phys_to_fire`. */
  from: string;
  /** The stat receiving it. */
  statId: string;
  /**
   * `transfer`, `core_stat` and `bonus_stat_per_effect` move or grant real modifiers, so they
   * carry a type and re-enter the container. Two cases cannot be expressed as a modifier:
   *
   *  - `ADD_TO_VALUE` — the after-calc passes write straight onto the resolved value.
   *  - `MULTI_ADD` — `InCalcStat.addFullyTo` does `other.Multi += 1 - Multi`, *adding* where
   *    every other MORE path multiplies. Reproducing that is deliberate, so naming it is too.
   */
  type: ModType | "ADD_TO_VALUE" | "MULTI_ADD";
  value: number;
};

export type EngineResult = {
  stats: Map<string, EngineStat>;
  /**
   * What was assumed up while this sheet was built.
   *
   * Returned rather than kept private so that everything downstream — the damage gates, the
   * debuffs on the mob, the toggle list on screen — reads the same answer the stats were built
   * from instead of resolving a second one that can disagree with it.
   */
  effects: EffectState;
  /** Every contribution, grouped by where it came from. */
  contexts: StatContext[];
  /** What steps 6 and 8 added on top, which no context can account for. */
  derived: DerivedContribution[];
  diagnostics: Diagnostic[];
};

/**
 * How many times the sheet is allowed to disagree with itself before the engine stops asking.
 *
 * Resolving what is up needs a finished sheet — the charge caps, the `give_exile_effect` grants
 * and the `inc_effect_of_*` buff strengths all live on it — and applying what is up produces one.
 * Usually one round settles it. It does not when an *effect* grants the stat that grants another
 * effect, which this pack does: `fury` carries `proc_combo_starter`, which is the only thing in
 * the game that hands out `combo_starter`, which is what every combo chain starts with. So the
 * loop runs until two consecutive answers agree.
 *
 * The game has the same circle and breaks it the same way, by recalculating whenever anything
 * changes (`UnsavedMaxEffectStacksData.calc` sweeps a container the effects are contributing to).
 * Three is well past what this pack needs and is a stop, not a budget: hitting it would mean two
 * effects that switch each other off, and the last answer is as good as any.
 */
const MAX_EFFECT_PASSES = 3;

/**
 * The character sheet, and what was assumed up while it was built.
 *
 * Callers that need both — `simulateDps` does, since the damage gates and the sheet have to
 * describe the same character — should use this rather than calling `calculate` and resolving
 * separately, which would do the work twice and could land on two different answers.
 */
/**
 * Settled sheets, keyed by the document object **and the snapshot** that produced them.
 *
 * The fixed point costs two or three full passes, and a single repaint asks for it more than once
 * — the stat sheet, the damage figure and the defence figure each want the character's sheet, and
 * each would run the loop again. A build document is replaced rather than edited in place (every
 * store action returns a new object), so identity is a sound key and a stale entry is unreachable
 * the moment anything changes.
 *
 * The snapshot is part of the key because the document alone is not enough to identify a sheet:
 * the same build read against two packs is two different characters. One process holds one
 * snapshot often enough that the hazard is quiet — and it stayed quiet until a test ran one
 * document against two snapshots and silently got the first one's pools back.
 */
const SETTLED = new WeakMap<BuildDoc, WeakMap<object, Map<string, EngineResult>>>();

type ComboState = { resources: readonly string[]; holds: readonly string[] };

function cacheKey(
  options: EngineOptions,
  preferred: readonly string[] | undefined,
  combo: ComboState | undefined,
): string {
  return [
    options.balanceId ?? "",
    options.baseStatsId ?? "",
    options.skill?.spellId ?? "",
    options.skill?.level ?? "",
    // Ids *and* rolls: two setups differing only in how well a support rolled are two different
    // stat sheets, and joining the raw array stringified every link to "[object Object]".
    (options.skill ? supportLinks(options.skill) : [])
      .map((link) => `${link.id}@${link.rollPercent ?? ""}${link.enabled === false ? "!off" : ""}`)
      .join("+"),
    options.vanillaHealth === false ? "0" : "1",
    options.newbieResists === false ? "0" : "1",
    (preferred ?? []).join(","),
    // Both halves: two rotations over the same resources that end holding different ones are two
    // different characters, and keying on the resource list alone would serve the first one's
    // sheet to the second.
    (combo?.resources ?? []).join(","),
    (combo?.holds ?? []).join(","),
  ].join("|");
}

export function resolveEffects(
  build: BuildDoc,
  snapshot: Snapshot,
  options: EngineOptions = {},
  preferred?: readonly string[],
  combo?: ComboState,
): EngineResult {
  const key = cacheKey(options, preferred, combo);
  const snapshotKey = snapshot as unknown as object;
  let perBuild = SETTLED.get(build);
  if (perBuild === undefined) {
    perBuild = new WeakMap();
    SETTLED.set(build, perBuild);
  }
  let perSnapshot = perBuild.get(snapshotKey);
  const hit = perSnapshot?.get(key);
  if (hit !== undefined) return hit;

  const settled = settle(build, snapshot, options, preferred, combo);
  if (perSnapshot === undefined) {
    perSnapshot = new Map();
    perBuild.set(snapshotKey, perSnapshot);
  }
  perSnapshot.set(key, settled);
  return settled;
}

function settle(
  build: BuildDoc,
  snapshot: Snapshot,
  options: EngineOptions,
  preferred: readonly string[] | undefined,
  combo: ComboState | undefined,
): EngineResult {
  const resolve = (sheet: Map<string, EngineStat>): EffectState =>
    resolveEffectState({
      snapshot,
      build,
      sheet,
      ...(preferred === undefined ? {} : { preferred }),
      ...(combo === undefined ? {} : { combo }),
      ...(options.balanceId === undefined ? {} : { balanceId: options.balanceId }),
    });

  let state = resolve(calculate(build, snapshot, { ...options, effects: NO_EFFECTS }).stats);
  for (let pass = 0; pass < MAX_EFFECT_PASSES; pass++) {
    const result = calculate(build, snapshot, { ...options, effects: state });
    const next = resolve(result.stats);
    if (sameEffects(state, next)) return result;
    state = next;
  }
  // Out of passes, so the answer is whatever the last round produced — used to build the sheet
  // this returns, which keeps the two consistent even though they did not settle.
  return calculate(build, snapshot, { ...options, effects: state });
}

/** Whether any worn offhand weapon grants stats, and so reads Dual-Wield Effectiveness. */
function wearsOffhandWeapon(build: BuildDoc, snapshot: Snapshot): boolean {
  const gear = wornItems(snapshot, build.gear ?? []);
  return gear.some((item) => offhandWeaponCounts(snapshot, item, gear));
}

/**
 * Runs the sheet until the offhand weapon's share agrees with the Dual-Wield Effectiveness it
 * produced.
 *
 * The same circle `CachedEntityStats` has: gear is cached before stats are calculated, so the
 * share is computed from the previous calculation's effectiveness, and `afterStatCalc` marks gear
 * dirty whenever the new value differs by more than 0.01. Effectiveness comes from perks and
 * affixes rather than from the offhand itself in this pack, so the second pass settles it; the
 * cap is the one {@link MAX_EFFECT_PASSES} uses and for the same reason.
 */
function settleDualWield(build: BuildDoc, snapshot: Snapshot, options: EngineOptions): EngineResult {
  let effectiveness = 0;
  for (let pass = 0; pass < MAX_EFFECT_PASSES; pass++) {
    const result = calculate(build, snapshot, { ...options, dualWieldEffectiveness: effectiveness });
    const next = result.stats.get(DUAL_WIELD_EFFECTIVENESS)?.value ?? 0;
    if (Math.abs(next - effectiveness) <= 0.01) return result;
    effectiveness = next;
  }
  return calculate(build, snapshot, { ...options, dualWieldEffectiveness: effectiveness });
}

/** `DualWieldEffectiveness`'s GUID. */
const DUAL_WIELD_EFFECTIVENESS = "dual_wield_effectiveness";

/** Two states agree when the same effects are up at the same stacks. Nothing else feeds back. */
function sameEffects(a: EffectState, b: EffectState): boolean {
  if (a.active.size !== b.active.size) return false;
  for (const [id, stacks] of a.active) {
    if (b.active.get(id) !== stacks) return false;
  }
  return true;
}

export function calculate(build: BuildDoc, snapshot: Snapshot, options: EngineOptions = {}): EngineResult {
  // Told what is up, this computes a sheet. Not told, it has to work that out first, and working
  // it out is itself a sheet — so the whole job belongs to `resolveEffects`, which owns the loop.
  const effects = options.effects;
  if (effects === undefined) return resolveEffects(build, snapshot, options);
  if (options.dualWieldEffectiveness === undefined && wearsOffhandWeapon(build, snapshot)) {
    return settleDualWield(build, snapshot, options);
  }

  const index = statIndex(snapshot);
  const bal = balance(snapshot, options.balanceId);
  const level = build.character.level;
  const env = makeEnv(snapshot, index, bal, level);

  // Gear and perks are built ahead of the list because the jewel budget is read off them, and
  // a jewel that has no socket is not collected at all. They go back into the list in place.
  const gearContexts = collectGear(env, build.gear ?? [], options.dualWieldEffectiveness ?? 0);
  const perkContexts = collectPerks(env, build);

  // 1. Collect. Order within the list does not matter — everything is summed into the
  //    container — but it is kept in the game's order so a provenance dump reads the same.
  //    Gem and spell stats come first (`allstats.addAll(gemstats)` precedes
  //    `allstats.addAll(statsWithoutSuppGems)`, StatCalculation.java:79-80).
  const contexts: StatContext[] = [
    // The skill's level comes from the class allocation when the document does not state one:
    // a spell perk's `learn_<spell>` stat *is* its rank.
    ...(options.skill
      ? collectSpellContexts(
          env,
          withLearnedRank(snapshot, build, options.skill, options.spellRanks),
          skillPath(build, options.skill),
          // The whole bar, because a spell that borrows its support gems needs the Skill it
          // borrows them from — and that Skill is somewhere else in the document.
          build.skills ?? [],
        )
      : []),
    ...collectBaseStats(env, options.baseStatsId ?? DEFAULT_PLAYER_BASE_STATS_ID),
    // Follows the base stats because it is the other half of the same number: the base stats
    // carry a flat -25 elemental/chaos resist, this carries the grant that offsets it.
    ...(options.newbieResists === false ? [] : collectNewbieResists(env)),
    // `PlayerData.statPoints` is its own `StatCtxType`, collected alongside gear and perks
    // rather than folded into the base stats — so a breakdown can name it.
    ...collectStatPoints(env, build),
    ...gearContexts,
    // Set bonuses follow the gear because they are a property of the whole combination
    // rather than of any piece — `addItemSetStats(gears)` takes the finished list.
    ...collectItemSets(env, build),
    // The omen reads the gear list to know what it is worth, so it follows it.
    ...collectOmen(env, build),
    // A Watcher's Eye reads the aura list to know which of its lines are live, so the set the
    // game keeps in `PlayerData.aurasOn` is built first. The socket budget comes from the two
    // contexts already built above it — see `jewelSockets`.
    ...collectJewels(env, build.jewels ?? [], aurasOn(build), jewelSockets(perkContexts, gearContexts, index)),
    ...perkContexts,
    // Spell schools are perks too, but levelled ones in their own PASSIVES context.
    ...collectSpellSchools(env, build),
    ...collectAuras(env, build.auras ?? []),
    ...collectFoodBuffs(env, build.foodBuffs ?? []),
    ...collectExileEffects(env, build, effects),
    // Vanilla attributes other mods set, converted by `mmorpg_stat_compat`.
    ...collectStatCompat(env, build),
  ];

  // 2. `CtxStats.addStatCtxModifierStats(allstats)` — stats that scale a whole context rather
  //    than adding to one. It reads the contexts collected above and appends one more, so a
  //    bonus can never feed another bonus.
  contexts.push(contextModifierBonus(contexts));

  // 3. Everything collected enters the container.
  const inCalc = new InCalcContainer(index);
  for (const ctx of contexts) {
    for (const mod of ctx.stats) inCalc.apply(mod);
  }

  // Steps 4, 6 and 8 move or add numbers that no context accounts for. Recorded as they
  // happen, because reconstructing them afterwards would mean running the passes again.
  const derived: DerivedContribution[] = [];

  // 3b. `InCalc.addVanillaHpToStats`, which runs between the contexts and `InCalc.modify`:
  //
  //     float maxhp = Mth.clamp(entity.getMaxHealth(), 0, 500);
  //     calc.getStatInCalculation(Health.getInstance()).addAlreadyScaledFlat(maxhp);
  //
  //  — StatCalculation.java:89, InCalc.java:22-31. Your vanilla hearts are *added to* the MnS
  // health pool, and `addAlreadyScaledFlat` is `this.Flat += val`, so it lands in the flat pool
  // and every percent and MORE on health multiplies it afterwards. A bare level 1 reads 100,
  // not 80: 80 from `original_mode_player` plus vanilla's own 20.
  if (options.vanillaHealth !== false) {
    const maxHealth = build.character.attributes?.["minecraft:generic.max_health"];
    if (typeof maxHealth === "number" && Number.isFinite(maxHealth)) {
      const capped = clamp(maxHealth, 0, VANILLA_HEALTH_CAP);
      if (capped !== 0) {
        inCalc.apply({ statId: "health", type: "FLAT", value: capped });
        derived.push({
          kind: "vanilla-health",
          statId: "health",
          from: "minecraft:generic.max_health",
          type: "FLAT",
          value: capped,
        });
      }
    }
  }

  // 4. `InCalc.modify`: stats that hand themselves to other stats, before anything resolves.
  applyTransfers(inCalc, index, derived);

  // 5. First resolution.
  let stats = inCalc.calculate();
  const firstPass = stats;

  // 6. Core stats grant their bundles, back into the same container, so `% intelligence`
  //    reaches the stats intelligence itself granted.
  applyCoreStats(inCalc, firstPass, index, env.level, bal, stacksOf(effects), derived);

  // 7. Second resolution.
  stats = inCalc.calculate();

  // 8. `AddToAfterCalcEnd`, in priority order, against a snapshot that only refreshes between
  //    priority tiers.
  applyAfterCalc(stats, firstPass, index, derived);

  // 9. The final clamp.
  stats.applySoftCaps();

  reportUnknownStats(env, index);

  return {
    stats: present(stats, index, env.level, bal),
    contexts,
    derived,
    effects,
    diagnostics: env.diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

/**
 * `ITransferToOtherStats`, via `InCalc.modify` (InCalc.java:28-33). The source keeps nothing:
 * `addFullyTo` copies Flat and Percent across and folds Multi in additively, then `clear()`
 * zeroes the source — including its Multi, which goes to 0 rather than 1.
 */
function applyTransfers(
  inCalc: InCalcContainer,
  index: StatIndex,
  derived: DerivedContribution[],
): void {
  for (const id of inCalc.ids()) {
    const def = index.get(id);
    if (!def || def.transfersTo.length === 0) continue;
    const source = inCalc.of(id);

    // Read before transferring: `clear()` zeroes the source, so afterwards there is nothing
    // left to say where the target's numbers came from. This is the whole reason
    // `elemental_resist` always reads 0 on the sheet while the three single elements carry
    // its value, and a breakdown that cannot explain that is missing the answer.
    const movedFlat = source.flat;
    const movedPercent = source.percent;
    const movedMulti = source.multi;

    for (const target of def.transfersTo) {
      source.addFullyTo(inCalc.of(target));
      if (movedFlat !== 0) {
        derived.push({ kind: "transfer", from: id, statId: target, type: "FLAT", value: movedFlat });
      }
      if (movedPercent !== 0) {
        derived.push({
          kind: "transfer",
          from: id,
          statId: target,
          type: "PERCENT",
          value: movedPercent,
        });
      }
      if (movedMulti !== 1) {
        derived.push({
          kind: "transfer",
          from: id,
          statId: target,
          type: "MULTI_ADD",
          value: 1 - movedMulti,
        });
      }
    }
    source.clear();
  }
}

/**
 * `ICoreStat.affectStats` for every stat resolved by the first pass:
 *
 *     for (Map.Entry<String, StatData> en : stats.entrySet()) {
 *         if (en.getValue().GetStat() instanceof ICoreStat aff) {
 *             aff.affectStats(data, en.getValue(), statCalc);
 *         }
 *     }
 *
 * The amount is truncated to an int (`getMods((int) data.getValue())`), and `CoreStat` builds
 * its grants with a hard-coded level of 1 — attributes do not scale what they give you, only
 * how much of it there is. `BonusStatPerEffectStacks` does honour `scale_to_lvl`, and
 * multiplies by how many stacks of its effect are up (BonusStatPerEffectStacks.java:70-82).
 */
function applyCoreStats(
  inCalc: InCalcContainer,
  firstPass: StatContainer,
  index: StatIndex,
  level: number,
  bal: ReturnType<typeof balance>,
  stacks: Map<string, number>,
  derived: DerivedContribution[],
): void {
  for (const [id, value] of firstPass.entries()) {
    const def = index.get(id);
    if (!def) continue;

    if (def.kind === "core_stat") {
      const amount = Math.trunc(value.value);
      for (const grant of def.grants) {
        const scaled = levelScale(grant.type, amount * grant.v1, 1, index.shapeOf(grant.statId), bal);
        inCalc.apply({ statId: grant.statId, type: grant.type, value: scaled });
        if (scaled !== 0) {
          derived.push({
            kind: "core_stat",
            from: id,
            statId: grant.statId,
            type: grant.type,
            value: scaled,
          });
        }
      }
    } else if (def.kind === "bonus_stat_per_effect") {
      const amount = Math.trunc(value.value);
      const up = stacks.get(def.effectId) ?? 0;
      for (const grant of def.grants) {
        const raw = up * amount * grant.v1;
        const scaled = levelScale(
          grant.type,
          raw,
          grant.scaleToLvl ? level : 1,
          index.shapeOf(grant.statId),
          bal,
        );
        inCalc.apply({ statId: grant.statId, type: grant.type, value: scaled });
        if (scaled !== 0) {
          derived.push({
            kind: "bonus_stat_per_effect",
            from: id,
            statId: grant.statId,
            type: grant.type,
            value: scaled,
          });
        }
      }
    }
  }
}

/**
 * The after-calculation pass.
 *
 *     int lastPriority = Integer.MIN_VALUE;
 *     for (var en : addToAfterCalcStats) {
 *         int currentPriority = ...;
 *         if (currentPriority > lastPriority && lastPriority != Integer.MIN_VALUE) {
 *             copiedStats = unit.getStats().clone();
 *         }
 *         aff.affectStats(copiedStats, unit.getStats(), en.getValue());
 *         lastPriority = currentPriority;
 *     }
 *
 * — StatCalculation.java:123-139. Three things carry:
 *
 *  - the snapshot is re-cloned only when the priority *increases*, so everything in one tier
 *    reads the same numbers and cannot see its neighbours' writes;
 *  - the set of stats that participate is the one from the **first** pass, and `more_x_per_y`
 *    reads its own value from there too, so a multiplier that only appears in pass two never
 *    fires;
 *  - `one_to_other` reads its adder with `getValue()`, which excludes `StatData.m`. A
 *    `MULTIPLICATIVE_DAMAGE` adder therefore contributes as though it had no MORE modifiers
 *    at all. That is a bug in the game and 14 stats in this pack hit it; reproducing it is the
 *    point.
 */
function applyAfterCalc(
  live: StatContainer,
  firstPass: StatContainer,
  index: StatIndex,
  derived: DerivedContribution[],
): void {
  const participants = firstPass
    .ids()
    .map((id) => index.get(id))
    .filter((def): def is StatDef => def !== undefined)
    .filter((def) => def.kind === "one_to_other" || def.kind === "more_x_per_y")
    // `MoreXPerYOf` has no priority field, so it sorts as Integer.MAX_VALUE — last.
    .map((def) => ({ def, priority: def.kind === "one_to_other" ? def.priority : Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.priority - b.priority);

  let snapshot = live.clone();
  let lastPriority: number | null = null;

  for (const { def, priority } of participants) {
    if (lastPriority !== null && priority > lastPriority) snapshot = live.clone();

    let added: number;
    if (def.kind === "one_to_other") {
      // multi = this stat's own value / 100, read from the snapshot, not the live container.
      const multi = snapshot.get(def.id).value / 100;
      added = snapshot.get(def.adderStat).value * multi;
    } else {
      // `(int) (adder.getValue() / perEach) * statData.getValue()` — integer division, and
      // the multiplier's own value comes from the first pass.
      const steps = Math.trunc(snapshot.get(def.adderStat).value / def.perAmount);
      added = steps * firstPass.get(def.id).value;
    }
    live.setValue(def.addTo, live.get(def.addTo).value + added);

    if (added !== 0) {
      derived.push({
        kind: def.kind,
        from: def.id,
        statId: def.addTo,
        type: "ADD_TO_VALUE",
        value: added,
      });
    }

    lastPriority = priority;
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * `PlayerData.aurasOn` — the aura gems socketed right now, which is what every "while under
 * this aura" line is tested against.
 *
 * In game there is no on/off switch: an aura gem in the inventory is running. The build
 * document has one anyway, because comparing two aura setups means turning one off, so an aura
 * the planner has unticked is not in the set either.
 */
/**
 * How many jewels this character may wear — `JewelInvHelper.getJewelSocketsMaxStat`:
 *
 *     int max = (int) Load.Unit(p).getUnit().getCalculatedStat(JewelSocketStat.getInstance()).getValue();
 *
 * It is a stat on the finished sheet, which looks circular and is not: **nothing a jewel can
 * carry grants `jewel_socket`**. Sweeping the pack, the only two sources are the `jewel_socket`
 * talent (18 cells in the talent grid, one point each) and two uniques — Bubonic Trail at 1-2
 * and Hungering Vessel at a flat 4. So the answer is fully determined by the gear and perk
 * contexts, which are collected before the jewels are, and reading it here costs one sweep of
 * two lists rather than a second stat calculation.
 *
 * The stat is FLAT-only in both sources, so summing the flats is the container's own answer.
 * `JewelSocketStat.max` is 9 and the cast to `int` truncates, both reproduced.
 */
function jewelSockets(
  perkContexts: readonly StatContext[],
  gearContexts: readonly StatContext[],
  index: StatIndex,
): number {
  let flat = 0;
  for (const ctx of [...perkContexts, ...gearContexts]) {
    for (const mod of ctx.stats) {
      if (mod.statId === JEWEL_SOCKET_STAT && mod.type === "FLAT") flat += mod.value;
    }
  }
  const shape = index.shapeOf(JEWEL_SOCKET_STAT);
  return Math.trunc(clamp(shape.base + flat, shape.min, shape.max));
}

const JEWEL_SOCKET_STAT = "jewel_socket";

function aurasOn(build: BuildDoc): ReadonlySet<string> {
  return new Set((build.auras ?? []).filter(isAuraEnabled).map((aura) => aura.id));
}

/**
 * `CtxStats.addCtxModifierStats` (CtxStats.java:43-63).
 *
 *     map.forEach((key, value) -> value.forEach(v -> v.stats.forEach(s -> {
 *         if (s.getStat().statContextModifier != null) {
 *             map.get(s.getStat().statContextModifier.getCtxTypeNeeded())
 *                .forEach(c -> list.addAll(s.getStat().statContextModifier.modify(s, c)));
 *         }
 *     })));
 *     return new SimpleStatCtx(StatContext.StatCtxType.STAT_CTX_MODIFIER_BONUS, list);
 *
 * Read the loop carefully: it walks **occurrences**, not the finished stat. Four separate
 * `aura_effect` lines of 6.69, 7.32, 3 and 16 each produce their own share of every AURA stat,
 * which is not the same as one line of 33.01 — for FLAT and PERCENT it sums to the same number,
 * but MORE modifiers multiply, so the game charges 1.0669 x 1.0732 x 1.03 x 1.16 where a single
 * 33.01% would be 0.2% light. Summing first would be wrong.
 *
 * `modify` is the interface default throughout: `target.getPercentOfStats(value / 100)`, which
 * copies each stat of the target context and multiplies `v1` alone — the modifier type carries
 * over untouched, so a share of a MORE is itself a MORE.
 */
function contextModifierBonus(contexts: readonly StatContext[]): StatContext {
  const stats: ExactMod[] = [];
  for (const ctx of contexts) {
    for (const mod of ctx.stats) {
      const target = CTX_MODIFIERS[mod.statId];
      if (target === undefined || mod.value === 0) continue;
      const multi = mod.value / 100;
      for (const other of contexts) {
        if (other.type !== target) continue;
        for (const stat of other.stats) {
          stats.push({
            statId: stat.statId,
            type: stat.type,
            value: stat.value * multi,
            // Both ends of the share, because neither alone identifies the row: a build with
            // four `aura_effect` lines and six auras produces twenty-four of these under one
            // heading, and the number beside each is meaningless without knowing whose stat it
            // is a cut of and which line took the cut.
            from: {
              kind: "share",
              id: mod.statId,
              by: { ctxType: ctx.type, source: ctx.source, path: ctx.path },
              of: { ctxType: other.type, source: other.source, path: other.path },
            },
          });
        }
      }
    }
  }
  return context("STAT_CTX_MODIFIER_BONUS", "ctx_modifiers", "character", stats);
}

/**
 * Stats this build referenced that exist in neither `mmorpg_stat` nor the generated
 * code-only table.
 *
 * They were calculated with `Stat`'s defaults, which is very likely wrong — an unknown stat
 * has no idea of its own cap or whether its MORE modifiers belong in the value. Regenerating
 * the code-only table against the installed mod version is the fix, which is why the message
 * says so.
 */
function reportUnknownStats(env: ReturnType<typeof makeEnv>, index: StatIndex): void {
  for (const statId of index.unknown) {
    env.report(
      "error",
      "unknown-stat",
      "character",
      `\`${statId}\` is in neither \`mmorpg_stat\` nor the ported code-only table, so it was calculated with \`Stat\`'s defaults. Regenerate with \`npm run port-stats -- --src <checkout> --snapshot <file>\`.`,
    );
  }
}

/**
 * Stacks of each effect **you** are holding, for `bonus_stat_per_effect`.
 *
 *     float val = data.statusEffects.getStacks(effect);
 *
 * — `BonusStatPerEffectStacks.getMods`, where `data` is the entity whose sheet is being built.
 * So it is the caster's own effects, which is why this filters by side rather than reading
 * `state.active`: that map is side-blind by design, and counting a debuff you put on a mob would
 * pay you `dmg_to_cursed_per_soul_stack` for the mob's stacks.
 *
 * This reads the **resolved** state and not `build.exileEffects`. Reading the document's own list
 * was the bug behind "my +2 max endurance charges does nothing": that list is what a capture
 * recorded, so the count was frozen at whatever the photograph caught, the `config.effects`
 * toggles could not move it, and a build written by hand — with no capture behind it at all —
 * got zero from every one of the pack's twenty charge stats.
 */
function stacksOf(effects: EffectState): Map<string, number> {
  const out = new Map<string, number>();
  for (const option of activeOn(effects, "caster")) out.set(option.id, option.stacks);
  return out;
}

function present(
  stats: StatContainer,
  index: StatIndex,
  level: number,
  bal: ReturnType<typeof balance>,
): Map<string, EngineStat> {
  const out = new Map<string, EngineStat>();
  for (const [id, stat] of stats.entries()) {
    const shape = index.shapeOf(id);
    const usable = usableValue(id, stat.value, level, bal, shape.scaling, shape.min, (s) =>
      stats.get(s).value,
    );
    out.set(id, {
      value: stat.value,
      dmgMulti: stat.dmgMulti,
      hardcap: shape.max,
      softcap: shape.softcap,
      ...(usable === undefined ? {} : { usableValue: usable }),
    });
  }
  return out;
}

/**
 * `IUsableStat.getUsableValue` (IUsableStat.java:26-36), scaled to the percentage the sheet
 * prints. The caller truncates the value to an int before passing it:
 *
 *     value = Math.max(0, value);
 *     float base = scaledvalueNeededToReachMaximumPercentAtLevelOne(lvl);
 *     float val = value / (value + base);
 *     return MathHelper.clamp(val, 0F, getMaxMulti());
 */
function usableValue(
  id: string,
  value: number,
  level: number,
  bal: ReturnType<typeof balance>,
  scaling: ReturnType<StatIndex["shapeOf"]>["scaling"],
  min: number,
  read: (statId: string) => number,
): number | undefined {
  const usable = USABLE_STATS[id];
  if (!usable) return undefined;

  // `ElementalResist.getUsableValue` (ElementalResist.java:114-119). The ceiling is 75 plus
  // this element's `MaxElementalResist`, itself clamped to 90 — *not* the stat's own `max`.
  // `clamp((float) value, min, BASE_BLOCK_CAP + max_block_chance)` — no outer clamp on the
  // ceiling, unlike a resist. The `(int)` on the parameter truncates the same way.
  if (usable.kind === "block") {
    return clamp(Math.trunc(value), min, BLOCK_BASE_CAP + read(usable.maxStat));
  }

  if (usable.kind === "resist") {
    const cap = clamp(RESIST_BASE_CAP + read(usable.maxStat), min, RESIST_HARD_CAP);
    // The `(int) data.getValue()` cast every call site performs applies here too — the
    // signature is `getUsableValue(Unit, int value, int lvl)`, so a 25.2% fire resist mitigates
    // 25%, not 25.2%. `Math.trunc` is the cast: both go toward zero, so -5.7 becomes -5.
    return clamp(Math.trunc(value), min, cap);
  }

  const amount = Math.max(0, Math.trunc(value));
  const base = usable.valueNeededAtLevelOne * bal.multiFor(scaling, level);
  if (amount + base === 0) return 0;
  return clamp(amount / (amount + base), 0, usable.maxMulti) * 100;
}

/**
 * Where in the document the skill this unit is for lives — `skills[0]`, or a bare root.
 *
 * It used to be the literal `"skill"`, on the reading that this unit is *the* skill and needs no
 * index. But the paths built under it are read back: `provenanceOf` parses
 * `skills[0].supports[2]` to find which gem a damage-trace row came off and prices its card at
 * that gem’s own roll, and `skill.supports[2]` matched nothing — so every support gem hovered
 * from the trace drew its card at 0%, showing a mythic’s stats at the bottom of their band
 * beside a row computed at 96%. A diagnostic reads better for the same reason: it names the
 * socket somebody can go and look at.
 *
 * Matched by `spellId` rather than by identity, because `withLearnedRank` hands back a copy and
 * not every caller passes the document’s own object. A skill that is not on the bar — a
 * candidate being priced by the support-gem picker — keeps the bare root, which is the honest
 * answer: there is no socket to point at.
 */
function skillPath(build: BuildDoc, skill: SkillSetup): string {
  const index = (build.skills ?? []).findIndex((s) => s.spellId === skill.spellId);
  return index < 0 ? "skill" : `skills[${index}]`;
}
