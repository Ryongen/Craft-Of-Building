/**
 * What your pets do while you are doing something else.
 *
 * Twenty-one spells in this pack declare `summonType != NONE` and, until this file, every one of
 * them reported zero damage. Seventeen more — `zombie_basic`, `wolf_basic`, `skeleton_basic`, the
 * three `*_golem_basic`, `spider_basic`, `pet_basic`, `merc_wolf_basic`, `cursed_zombie_basic`
 * and their `_deprecated` twins — reported zero sources and their one real component group as
 * *unreachable*. It was not unreachable. It had a different driver.
 *
 * ## The driver
 *
 * `PetAttackUTIL.tryAttack` is what a summon's melee swing runs, and it is four lines:
 *
 *     Spell basic = spell.getConfig().getSummonBasicSpell();
 *     var ctx = new SpellCastContext(caster, 0, basic);
 *     basic.attached.onCast(SpellCtx.onCast(caster, ctx.calcData));
 *     basic.attached.tryActivate(Spell.DEFAULT_EN_NAME, SpellCtx.onHit(caster, summon, target, ctx.calcData));
 *
 * Three things fall out of it, and together they are the whole model:
 *
 *   - **the pet's group is entered directly.** `tryActivate(DEFAULT_EN_NAME, …)` runs
 *     `default_entity_name` with an `on_hit` context. Nothing casts it and nothing spawns it,
 *     which is why walking from `on_cast` found nothing — hence `entryGroup` on `skillModel`.
 *   - **the caster is you.** `new SpellCastContext(caster, 0, basic)` is built from the summoner,
 *     so the pet's bite is scored against *your* stat sheet, as the spell `basic`. Every pet
 *     basic in the pack then carries `use_support_gems_from: "<its summon skill>"`, so your
 *     support gems reach it too. A pet is not a separate character with its own gear; it is a
 *     spell of yours on somebody else's clock.
 *   - **`summon_damage` needs no special handling.** It is an ordinary datapack stat —
 *     `_additive_damage_number_add_stat_data`, `order: damage_layers`, gated on
 *     `spell_has_tag_summon` — and every pet basic carries the `summon` tag, so the existing
 *     stat sweep applies it without being told about summons at all.
 *
 * ## The clock
 *
 * A pet swings on vanilla's AI goals, not on anything in the datapack. `SummonEntity.registerGoals`
 * disassembles in `Mine_and_Slash-1.20.1-6.4.13.jar` to
 *
 *     if (usesMelee())  goalSelector.addGoal(5, new MeleeAttackGoal(this, 1.0D, true));
 *     if (usesRanged()) goalSelector.addGoal(5, new RangedBowAttackGoal(this, 1.0D, 10, 10.0f));
 *
 * and of the eight summon entity classes in that jar exactly one overrides either: `SkeletonSummon`
 * returns `usesRanged() = true` and `usesMelee() = false`. Every other pet — zombie, wolf, spider
 * and all three golems — inherits melee-only from `SummonEntity`.
 *
 * So there are two rates, and both are vanilla's:
 *
 *   - **melee, 20 ticks.** `MeleeAttackGoal.resetAttackCooldown` sets
 *     `ticksUntilNextAttack = adjustedTickDelay(20)`, and `MeleeAttackGoal.requiresUpdateEveryTick()`
 *     is true, so the adjustment is the identity. One swing a second.
 *   - **ranged, 30 ticks.** `RangedBowAttackGoal` counts `attackTime` down from `attackIntervalMin`
 *     — the `10` read out of the jar above — then draws the bow, and only fires once
 *     `getTicksUsingItem() >= 20`. The draw is not part of the interval, so the cycle is the sum.
 *
 * **What is pinned and what is not.** The two constants the mod passes (`10` and `10.0f`) and
 * which class is ranged are read out of the running jar's bytecode. The vanilla halves — the
 * 20-tick melee reset and the 20-tick bow draw — are standard 1.20.1 behaviour and were *not*
 * re-read from the Minecraft jar, which this Prism layout does not keep where the mod jar is. If
 * a pet's damage ever disagrees with a capture, this is the first place to look.
 *
 * Note that the pet's rate is not the player's `attack_speed`. Nothing in `MeleeAttackGoal` reads
 * an attribute, so a summoner stacking attack speed does not make their zombies bite faster — a
 * real and counter-intuitive fact about the build, and one worth a planner saying out loud.
 *
 * ## How many
 *
 * `SummonPetAction.updatePlayerSummons` culls oldest-first down to the cap:
 *
 *     int excess = ofCappedType.size() - typeCap;
 *
 * where `typeCap` is `EventData.BONUS_TOTAL_SUMMONS` — already resolved on every `SpellCalc` as
 * `bonusTotalSummons`, because the `max_<type>_summons` stats write into it through
 * `add_total_summons` on `on_spell_stat_calc`, each gated on `summon_type_is_<type>`. The base
 * sheet grants 3 undead, 3 spider, 2 beast and 1 golem before any perk.
 *
 * ## What else a pet casts
 *
 * Three skills — the golems — declare `summon_spells`, and `SummonSpellCaster.tryCastOnHit` rolls
 * for one on every hit the pet lands. Confirmed against the running jar, where the order of the
 * four steps is the part that matters:
 *
 *     if (cds.isOnCooldown(CD_KEY)) return;
 *     int chance = config.summon_spell_chance + golemBonus(source, summoner);
 *     if (chance < 1) return;
 *     cds.setOnCooldown(CD_KEY, Math.max(1, config.summon_spell_cd_ticks));
 *     if (!RandomUtils.roll(chance)) return;
 *     fire(summon, summoner, target, RandomUtils.randomFromList(spells));
 *
 * **The cooldown is stamped on the attempt, not on the success.** So the rate is not
 * `hits × chance` capped by the cooldown — it is the *attempt* rate that the cooldown caps, and
 * the roll then thins it. At a 20-tick cooldown a pet gets at most one attempt a second however
 * fast it hits, and a 10% chance turns that into one nova every ten seconds.
 *
 * All three golems declare `summon_spell_chance: 0`, so the whole of the chance is `golemBonus` —
 * the player's `golem_spell_chance` stat, which the base sheet grants at 10 to every character
 * and `p_golem_chance` raises by 3 a point. The bonus is keyed on the *summon skill* carrying the
 * `golem` tag, not on the pet's class, which is why it is read off the summoning spell here.
 *
 * `randomFromList` picks one, so with several the expected damage is their mean. All three golems
 * declare exactly one.
 *
 * A pet with `counts_towards_max_summons: false` is exempt from that cull — the seven burst
 * summons, `summon_skeleton_army` and `summon_spider` among them — and is bounded by its own
 * lifespan against how often you can recast it instead. That is the same overlap arithmetic the
 * engine already does for a projectile that outlives its cast, and it carries the same caveat:
 * it assumes you spend the press on this and nothing else.
 */

import type { Snapshot } from "@cte2/extractor";
import type { Diagnostic } from "@cte2/schema";
import { CATEGORY, entry } from "@cte2/schema";

import type { SpellCalc } from "./spell-calc.js";
import { TICKS_PER_SECOND } from "./spell-calc.js";

/** `MeleeAttackGoal.resetAttackCooldown` — `adjustedTickDelay(20)`, unadjusted. */
const MELEE_ATTACK_TICKS = 20;

/**
 * `RangedBowAttackGoal`: `attackIntervalMin` waiting, then the bow draw before it fires.
 *
 * The mod passes 10; vanilla will not loose the arrow until `getTicksUsingItem() >= 20`, and that
 * draw is not inside the interval. 10 alone would report a skeleton shooting twice as fast as it
 * does.
 */
const RANGED_ATTACK_TICKS = 10 + 20;

/**
 * The pet entities that shoot rather than bite.
 *
 * Keyed on the entity the `summon_pet` act names rather than on the basic attack's tags, because
 * the two disagree and the entity is the one that decides. `merc_wolf_basic` is tagged `ranged`
 * and summons `mmorpg:spirit_wolf`, whose `WolfSummon` overrides neither `usesMelee` nor
 * `usesRanged` — so it is a melee pet with a misleading tag, and reading the tag would have given
 * it a 30-tick clock it does not have.
 */
const RANGED_PETS = new Set(["mmorpg:skeleton"]);

/** One summon skill's pets, and what they are worth. */
export type SummonOutput = {
  /** The summoning skill. */
  spellId: string;
  /** The entity id the `summon_pet` act names, e.g. `mmorpg:zombie`. */
  petId: string;
  /** The basic-attack spell the pet runs on every swing. */
  basicSpellId: string;
  /** `SummonType` — which cap the pet counts against. */
  summonType: string;
  /** Pets alive at once, in the steady state. */
  count: number;
  /** Why the count is what it is, because it is the part a player will want to argue with. */
  countNote: string;
  /** True when the cap applies; false for a burst summon bounded by its own lifespan. */
  capped: boolean;
  /** Seconds between one pet's attacks. */
  attackSeconds: number;
  /** Whether the pet bites or shoots, and therefore which clock it is on. */
  attackKind: "melee" | "ranged";
  /** Seconds a pet lives. `Infinity` for the `-1` that means it never expires. */
  lifeSeconds: number;
  /** Damage one pet's attack puts on the target. */
  damagePerAttack: number;
  /** `count × damagePerAttack / attackSeconds`. */
  dps: number;
  /** The spells this pet casts on top of its swing, when the summon skill declares any. */
  extraSpells: SummonSpellCast[];
};

/** One `summon_spells` entry, and how often the pets get it off. */
export type SummonSpellCast = {
  /** The spells rolled between. `randomFromList` picks one, so the damage is their mean. */
  spellIds: string[];
  /** Percent chance per attempt, `summon_spell_chance + golem_spell_chance`. */
  chance: number;
  /** `summon_spell_cd_ticks`, which caps *attempts* rather than successes. */
  cooldownTicks: number;
  /** Casts a second across every pet. */
  perSecond: number;
  /** Mean damage of one cast. */
  damagePerCast: number;
  dps: number;
};

export type SummonInput = {
  snapshot: Snapshot;
  /** The summoning spell's raw data. */
  spell: Record<string, unknown>;
  spellId: string;
  /** The summoning spell's own calc, for the cap and the duration multiplier. */
  calc: SpellCalc;
  /** How often the summoning skill comes back round, for a burst summon's overlap. */
  cycleSeconds: number;
  /** One activation of the pet's basic attack, against the same target the figure is about. */
  damageOf: (basicSpellId: string) => number;
  /** One cast of a spell the pet casts on hit, as an ordinary cast of yours. */
  damageOfCast: (spellId: string) => number;
  /** The character's `golem_spell_chance`, which is the whole of a golem nova's chance. */
  golemSpellChance: number;
  diagnostics: Diagnostic[];
};

/** The raw `summon_pet` act, as the datapack writes it. */
type PetAct = {
  petId: string;
  count: number;
  lifeTicks: number;
  countsTowardsMax: boolean;
  summonType: string;
};

/**
 * What this skill's pets add, or an empty list when it summons none.
 *
 * Empty is the honest answer for `summon_wisp` and `summon_wraith`, the two `summonType != NONE`
 * spells with no `summon_pet` act at all: they place entities through the ordinary carrier acts,
 * so the main damage walk already counts them and counting them again here would double them.
 */
export function resolveSummons(input: SummonInput): SummonOutput[] {
  const { snapshot, spell, spellId, calc } = input;
  const basicSpellId = summonBasicAttack(spell);
  const acts = petActs(spell);
  if (acts.length === 0) return [];

  if (basicSpellId === undefined) {
    input.diagnostics.push({
      severity: "info",
      code: "summon-no-basic-attack",
      path: "skills",
      message:
        `\`${spellId}\` summons a pet but declares no \`summon_basic_atk\`, so the pet has ` +
        `nothing to attack with and adds no damage.`,
    });
    return [];
  }
  if (entry(snapshot, CATEGORY.spell, basicSpellId) === undefined) {
    input.diagnostics.push({
      severity: "warning",
      code: "summon-basic-attack-unknown",
      path: "skills",
      message:
        `\`${spellId}\` names \`${basicSpellId}\` as its summon's basic attack, which is not a ` +
        `${CATEGORY.spell} entry. Its pets are counted at no damage.`,
    });
  }

  const damagePerAttack = input.damageOf(basicSpellId);
  const out: SummonOutput[] = [];

  for (const act of acts) {
    const attackKind = RANGED_PETS.has(act.petId) ? "ranged" : "melee";
    const attackSeconds =
      (attackKind === "ranged" ? RANGED_ATTACK_TICKS : MELEE_ATTACK_TICKS) / TICKS_PER_SECOND;

    // `getDuration` multiplies the declared lifespan by `DURATION_MULTI`, and leaves the `-1`
    // sentinel alone — a permanent pet stays permanent however much duration you stack.
    const lifeSeconds =
      act.lifeTicks < 0
        ? Number.POSITIVE_INFINITY
        : (act.lifeTicks * calc.durationMulti) / TICKS_PER_SECOND;

    const { count, note } = liveCount(act, calc, input.cycleSeconds, lifeSeconds);
    const extraSpells = petSpells(input, spell, count, attackSeconds);

    out.push({
      spellId,
      petId: act.petId,
      basicSpellId,
      summonType: act.summonType,
      count,
      countNote: note,
      capped: act.countsTowardsMax,
      attackSeconds,
      attackKind,
      lifeSeconds,
      damagePerAttack,
      dps:
        (attackSeconds > 0 ? (count * damagePerAttack) / attackSeconds : 0) +
        extraSpells.reduce((sum, cast) => sum + cast.dps, 0),
      extraSpells,
    });
  }

  return out;
}

/**
 * The spells the pets cast on top of biting, and how often they land one.
 *
 * The rate is the part worth being careful about. `tryCastOnHit` stamps the cooldown on the
 * *attempt* and rolls afterwards, so a pet that hits faster than the cooldown does not get more
 * chances — it gets one attempt per cooldown, and the roll thins that. Computing it the other way
 * round (`hits × chance`, then cap) over-reports any pet whose swing outpaces the cooldown, which
 * is every melee pet at a 20-tick cooldown and a 20-tick swing.
 */
function petSpells(
  input: SummonInput,
  spell: Record<string, unknown>,
  count: number,
  attackSeconds: number,
): SummonSpellCast[] {
  const config = asObject(spell["config"]) ?? {};
  const spellIds = Array.isArray(config["summon_spells"])
    ? config["summon_spells"].filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (spellIds.length === 0 || count <= 0 || attackSeconds <= 0) return [];

  // `golemBonus` is keyed on the summoning skill carrying the `golem` tag, not on the pet class.
  const tags = asObject(config["tags"]);
  const tagList = Array.isArray(tags?.["tags"]) ? (tags["tags"] as unknown[]) : [];
  const isGolem = tagList.includes("golem");
  const declared = numberAt(config, "summon_spell_chance") ?? 0;
  const chance = declared + (isGolem ? input.golemSpellChance : 0);
  // `if (chance < 1) return;` — and it returns *before* the cooldown is stamped, so a pet with no
  // chance at all is not merely unlucky, it never attempts.
  if (chance < 1) return [];

  const cooldownTicks = Math.max(1, Math.trunc(numberAt(config, "summon_spell_cd_ticks") ?? 20));
  const cooldownSeconds = cooldownTicks / TICKS_PER_SECOND;
  // One pet attempts at whichever is slower: its own swing, or its own cooldown.
  const attemptsPerPet = Math.min(1 / attackSeconds, 1 / cooldownSeconds);
  const perSecond = count * attemptsPerPet * (Math.min(100, chance) / 100);

  // `randomFromList` is uniform, so several spells average. All three golems declare one.
  const damagePerCast =
    spellIds.reduce((sum, id) => sum + input.damageOfCast(id), 0) / spellIds.length;

  return [
    {
      spellIds,
      chance,
      cooldownTicks,
      perSecond,
      damagePerCast,
      dps: damagePerCast * perSecond,
    },
  ];
}

/** The total a rotation's summons add, for the headline. */
export function summonDps(summons: readonly SummonOutput[]): number {
  return summons.reduce((sum, summon) => sum + summon.dps, 0);
}

/**
 * How many of this pet are out at once.
 *
 * Two regimes, and which one applies is `counts_towards_max_summons` on the act itself rather
 * than anything about the summon type.
 */
function liveCount(
  act: PetAct,
  calc: SpellCalc,
  cycleSeconds: number,
  lifeSeconds: number,
): { count: number; note: string } {
  if (act.countsTowardsMax) {
    // `updatePlayerSummons` discards oldest-first down to the cap on every summon, so a player
    // who keeps pressing the button sits exactly at it. Casting fewer times than that is a
    // choice the document cannot express and the steady state is the useful answer.
    const cap = Math.max(0, Math.trunc(calc.bonusTotalSummons));
    if (cap === 0) {
      return {
        count: 0,
        note:
          `Nothing in this build raises \`max_${act.summonType.toLowerCase()}_summons\`, so the ` +
          `cap is 0 and every pet is culled the moment it is summoned.`,
      };
    }
    return {
      count: cap,
      note:
        `The ${act.summonType.toLowerCase()} cap is ${cap}, and each cast summons ` +
        `${act.count}, so ${Math.ceil(cap / Math.max(1, act.count))} cast(s) fills it. Older ` +
        `pets are culled past the cap rather than the new one being refused.`,
    };
  }

  // Exempt from the cull, so what bounds it is how long a pet lives against how often the button
  // comes back — the same overlap the engine computes for a projectile that outlives its cast.
  if (!Number.isFinite(lifeSeconds)) {
    return {
      count: act.count,
      note:
        `These pets never expire and do not count against a cap, so nothing bounds them but how ` +
        `often you cast. One cast's worth is reported.`,
    };
  }
  if (cycleSeconds <= 0) return { count: act.count, note: `One cast's worth.` };

  const waves = Math.max(1, lifeSeconds / cycleSeconds);
  return {
    count: act.count * waves,
    note:
      `Uncapped, so they pile up: each pet lives ${round(lifeSeconds)}s and the skill comes back ` +
      `every ${round(cycleSeconds)}s, which is ${round(waves)} wave(s) of ${act.count} alive at ` +
      `once, assuming every press goes on this rather than on anything else.`,
  };
}

function summonBasicAttack(spell: Record<string, unknown>): string | undefined {
  const config = asObject(spell["config"]);
  const id = config === undefined ? undefined : config["summon_basic_atk"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Every `summon_pet` act in the tree, wherever in it they sit. */
function petActs(spell: Record<string, unknown>): PetAct[] {
  const out: PetAct[] = [];
  walk(spell["attached"], (node) => {
    if (node["type"] !== "summon_pet") return;
    const map = asObject(node["map"]) ?? {};
    const petId = typeof map["summon_id"] === "string" ? map["summon_id"] : undefined;
    if (petId === undefined) return;
    out.push({
      petId,
      count: Math.max(1, Math.trunc(numberAt(map, "count") ?? 1)),
      lifeTicks: Math.trunc(numberAt(map, "life_ticks") ?? -1),
      // `MapField.COUNTS_TOWARDS_MAX_SUMMONS` defaults to true, the same way `getOrDefault` does.
      countsTowardsMax: map["counts_towards_max_summons"] !== false,
      summonType: typeof map["summon_type"] === "string" ? map["summon_type"] : "NONE",
    });
  });
  return out;
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const node = asObject(value);
  if (node === undefined) return;
  visit(node);
  for (const child of Object.values(node)) walk(child, visit);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberAt(map: Record<string, unknown>, key: string): number | undefined {
  const value = map[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
