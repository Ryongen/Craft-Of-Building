/**
 * One-click enemies to measure damage against.
 *
 * These follow the Training Dummy mod's `DummyPreset`, deliberately: that mod is already in the
 * pack, and a number produced here is only worth anything if it is measured against the same
 * block of stats the dummy in game is carrying. Same names, same rarities, same arithmetic.
 *
 * Two deliberate differences, both additive:
 *
 *   - **`mirror` is absent.** The dummy's version copies the player's own stats onto the target
 *     so you can fight yourself, which needs a full second stat calculation aimed at the
 *     defensive side. That is a different feature from measuring damage.
 *   - **the five elite rarities between common and boss are offered.** The dummy reaches them
 *     through its stat editor rather than through a preset button; each is one `stat_multi`
 *     away from the others and a map is mostly made of them, so a figure measured only against
 *     `common_mob` and `map_boss` is measured against the two rarities you fight least.
 *
 * Everything else is the dummy's arithmetic, including the one that is *not* a rarity:
 * `max_resist` solves its armour for a mitigation fraction rather than copying a rarity's —
 * see `buildTargetEnemy`.
 *
 * ## Why this reproduces a formula the engine elsewhere refuses to
 *
 * `EnemySetup` says, in as many words, that a target's defences are *stated rather than
 * derived* — reproducing `MobStatUtils.getMobBaseStats` would stack a second unverified
 * calculation underneath every damage number, and a mismatch would not say which half was
 * wrong. That is still true, and nothing here changes it: a preset **fills the `enemy` block**
 * and the engine goes on reading only that block. The preset is a starting point you can edit,
 * not a calculation the damage pipeline depends on, and `BuildConfig.targetPreset` records
 * which one it came from so a stale block is recognisable after a pack update.
 *
 * ## What Mine and Slash actually gives a mob
 *
 * `MobStatUtils.getMobBaseStats` is short, and all of it matters here:
 *
 *     list.add(ExactStatData.scaleTo(10 * rarity.StatMultiplier(), FLAT, Armor.GUID, level));
 *     for (Elements element : Elements.getAllSingle()) {
 *         if (element == Elements.Physical) continue;
 *         list.add(ExactStatData.noScaling(10 * rarity.StatMultiplier(), FLAT,
 *                 new ElementalResist(element).GUID()));
 *     }
 *     rarity.stats.forEach(...)
 *
 * Three things follow, and each of them surprises someone:
 *
 *   - **no mob has physical resistance.** Armour alone stops a physical hit, and armour and
 *     physical resistance are separate mitigation layers that would multiply. Setting both is
 *     taking two cuts out of the same hit, which nothing in the game does;
 *   - **resistances do not scale with level.** `noScaling` — a boss has the same 35 resist at
 *     level 1 and level 100. Armour *does* scale, through the same `NORMAL_STAT_SCALING` curve
 *     the mitigation formula divides by again, so the percentage armour buys is level-independent
 *     even though the number is not;
 *   - **the resist is the raw number, not the 75% it clamps to** when a hit lands, and
 *     penetration comes off it *before* the clamp. A boss's 35 swallows the first 35 elemental
 *     penetration for nothing.
 */

import type { Snapshot } from "@cte2/extractor";

import type { EnemySetup, MobOffence } from "./build-doc.js";
import { SINGLE_ELEMENTS } from "./elements.js";
import { CATEGORY, MOB_BASE_STATS_ID, entry, ids } from "./queries.js";

/** `MobStatUtils`: `10 * rarity.StatMultiplier()` is both the armour and every resist. */
const MOB_BASE_STAT = 10;

/** `ElementalResist.getUsableValue` clamps the resist to 90 however much is stacked. */
const RESIST_HARD_CAP = 90;

/**
 * `MaxElementalResist.max` — the ceiling on the stat that lifts the 75% base cap.
 *
 * 75 + 15 is exactly the 90 hard cap, which is why the dummy's Max Resist preset pins 15 rather
 * than something larger: there is nothing larger to pin.
 */
const MAX_ELEMENTAL_RESIST_STAT_MAX = 15;

/** The physical mitigation the dummy's Max Resist preset solves its armour for. */
const MAX_RESIST_MITIGATION = 0.75;

/**
 * `Armor.valueNeededToReachMaximumPercentAtLevelOne()` and `Armor.getMaxMulti()`.
 *
 * Both are code constants on the stat rather than datapack fields, so they cannot be read off a
 * snapshot. The engine keeps the same pair in `USABLE_STATS`.
 */
const ARMOUR_AT_LEVEL_ONE = 100;
const ARMOUR_MAX_MULTI = 0.9;

/** `IRarity.COMMON_ID` and the special rarities the presets name. */
const RARITY = {
  common: "common",
  uncommon: "uncommon",
  rare: "rare",
  epic: "epic",
  legendary: "legendary",
  mythic: "mythic",
  boss: "boss",
  uber: "uber",
  pinnacle: "pinnacle",
} as const;

export type TargetPresetId =
  | "naked"
  | "common_mob"
  | "uncommon_mob"
  | "rare_mob"
  | "epic_mob"
  | "legendary_mob"
  | "mythic_mob"
  | "map_boss"
  | "uber_boss"
  | "pinnacle_boss"
  | "max_resist";

export type TargetPreset = {
  id: TargetPresetId;
  name: string;
  description: string;
  /**
   * The `mmorpg_mob_rarity` this preset *is*, when it is simply a rarity.
   *
   * Everything a rarity preset produces comes off `stat_multi`, so naming the rarity is the
   * whole definition — `naked` and `max_resist` are the two that are not one and carry
   * `undefined` here. It is also what lets a picker hide a preset whose rarity a pack has
   * dropped, rather than silently falling back to common.
   */
  rarityId?: string;
};

/**
 * The presets, in the order the dummy's config screen lists them — least mitigation first, so
 * reading down the list is reading a build's damage falling off.
 *
 * `mirror` is deliberately absent. The dummy's version copies the player's own stats onto the
 * target so you can fight yourself, which needs a full second stat calculation aimed at the
 * defensive side; that is a different feature from measuring damage.
 */
export const TARGET_PRESETS: readonly TargetPreset[] = [
  {
    id: "naked",
    name: "Naked",
    description:
      "No mitigation at all. Measures raw output, and is the baseline every other preset is worth reading against.",
  },
  {
    id: "common_mob",
    name: "Common mob",
    description: "Whatever Mine and Slash gives a common mob of this level.",
    rarityId: RARITY.common,
  },
  // The five elite rarities between a common mob and a boss. These are what a map is actually
  // full of — `epic` alone is weighted 16 against common's 1024 — so a damage figure measured
  // only against `common_mob` or `map_boss` is measured against the two rarities you fight
  // least. Each is one `stat_multi` away from the others: 1.2, 1.5, 1.9, 2.4, 3.
  {
    id: "uncommon_mob",
    name: "Uncommon mob",
    description: "A blue mob (`uncommon` rarity).",
    rarityId: RARITY.uncommon,
  },
  {
    id: "rare_mob",
    name: "Rare mob",
    description: "A yellow mob (`rare` rarity).",
    rarityId: RARITY.rare,
  },
  {
    id: "epic_mob",
    name: "Epic mob",
    description: "The most common elite (`epic` rarity).",
    rarityId: RARITY.epic,
  },
  {
    id: "legendary_mob",
    name: "Legendary mob",
    description: "MnS's `legendary` rarity.",
    rarityId: RARITY.legendary,
  },
  {
    id: "mythic_mob",
    name: "Mythic mob",
    description: "The rarest non-boss elite (`mythic` rarity).",
    rarityId: RARITY.mythic,
  },
  {
    id: "map_boss",
    name: "Map boss",
    description: "A normal map's boss (`boss` rarity).",
    rarityId: RARITY.boss,
  },
  {
    id: "uber_boss",
    name: "Uber boss",
    description: "What an uber altar spawns (`uber` rarity).",
    rarityId: RARITY.uber,
  },
  {
    id: "pinnacle_boss",
    name: "Pinnacle boss",
    description: "What an uber altar spawns in a pinnacle map (`pinnacle` rarity).",
    rarityId: RARITY.pinnacle,
  },
  {
    id: "max_resist",
    name: "Max resist",
    description:
      "All resistances at the 90% cap and enough armour for 75% physical mitigation (a real " +
      "boss has much less). Shows what penetration is worth.",
  },
] as const;

/**
 * What a mob hits *with* — the other half of a target, and the half a preset cannot invent.
 *
 * A {@link TargetPreset} describes what the mob can take: armour and resists off its rarity's
 * `stat_multi`, which is pack data and so is the game's own answer. Its *offence* is not, because
 * `MobStatUtils.getMobBaseStats` gives a mob a single line of it —
 *
 *     stats.add(ExactStatData.scaleTo(1, ModType.FLAT, OffenseStats.ACCURACY.get().GUID(), lvl));
 *
 * — and `mmorpg_entity`'s 190 definitions carry no attack damage either. The hit comes from the
 * Minecraft entity's own `generic.attack_damage` attribute, which nothing in the install knows
 * about until something is standing in front of you.
 *
 * So these are Minecraft's constants, cited, in the same standing as the hand-ported
 * `CompatConfigPreset` numbers in the engine's `compat.ts`. They are applied by an explicit
 * click rather than folded into {@link buildTargetEnemy}, because a target preset that quietly
 * started stating an attack damage would put a number under every defensive figure that the
 * document never asked for.
 *
 * The rates are the vanilla `MeleeAttackGoal` cadence of roughly one swing a second. Mine and
 * Slash's own ceiling is 4/s — `BASIC_ATTACK_COOLDOWN_ID` is 5 ticks — and nothing here is near
 * it.
 *
 * **These will look more alike than you expect, and that is correct.** The mod turns a vanilla
 * attack damage into a hit as `(v * 0.33 / 100) + 6`, so the attribute is a third of a percent
 * against a flat 6: a zombie and a vindicator come out within one percent of each other once the
 * level curve has multiplied both. What actually differs between these profiles is the *rate*.
 * See `damage/incoming.ts` for the arithmetic and the jar constants behind it.
 */
export type AttackerProfile = {
  id: string;
  name: string;
  /** `generic.attack_damage` on the vanilla entity, before Mine and Slash scales it. */
  vanillaAttackDamage: number;
  attacksPerSecond: number;
  /** Where the number comes from, so a reader can check it rather than trust it. */
  citation: string;
};

export const ATTACKER_PROFILES: readonly AttackerProfile[] = [
  {
    id: "zombie",
    name: "Zombie",
    vanillaAttackDamage: 3,
    attacksPerSecond: 1,
    citation: "minecraft:zombie, generic.attack_damage 3.0. A regular overworld melee mob.",
  },
  {
    id: "skeleton",
    name: "Skeleton",
    vanillaAttackDamage: 2,
    attacksPerSecond: 0.5,
    citation:
      "minecraft:skeleton shooting rather than swinging: an arrow's 2.0 base, loosed on the " +
      "bow goal's own two-second cadence.",
  },
  {
    id: "vindicator",
    name: "Vindicator",
    vanillaAttackDamage: 13,
    attacksPerSecond: 1,
    citation: "minecraft:vindicator, generic.attack_damage 13.0 on Normal. A raid-tier melee hit.",
  },
  {
    id: "ravager",
    name: "Ravager",
    vanillaAttackDamage: 12,
    attacksPerSecond: 0.5,
    citation:
      "minecraft:ravager, generic.attack_damage 12.0, slow roar-and-charge attacks. The " +
      "closest vanilla gets to a boss.",
  },
] as const;

export function attackerProfile(id: string): AttackerProfile | undefined {
  return ATTACKER_PROFILES.find((p) => p.id === id);
}

export function isTargetPresetId(value: string): value is TargetPresetId {
  return TARGET_PRESETS.some((p) => p.id === value);
}

export function targetPreset(id: string): TargetPreset | undefined {
  return TARGET_PRESETS.find((p) => p.id === id);
}

/**
 * Builds the enemy block a preset means, at a level.
 *
 * The level matters twice over. Armour is level-scaled by MnS, and the mitigation it buys is
 * computed against the **attacker's** level (`ArmorEffect` reads `sourceData.getLevel()`, never
 * the target's) — so an enemy pinned to a level the character has not reached would otherwise
 * mitigate more than the preset claims. Pass the character's level unless you are deliberately
 * modelling an over-level target.
 */
export function buildTargetEnemy(
  snapshot: Snapshot,
  id: TargetPresetId,
  level: number,
  balanceId?: string,
): EnemySetup {
  const lvl = Math.max(1, Math.trunc(level));

  if (id === "naked") {
    // Everything zeroed, offence included: the dummy's Naked preset strips the return hit down to
    // the bare number MnS gives a mob of that level. It leaves health and critical damage at MnS's
    // own values because zero is not meaningful for either, and neither is a defence the damage
    // pipeline reads, so neither appears here at all.
    return {
      level: lvl,
      armor: 0,
      resists: zeroResists(),
      blockChance: 0,
      dodge: 0,
      damageReduction: 0,
      offence: { accuracy: 0, armorPenetration: 0, penetration: zeroResists(), critChance: 0 },
    };
  }

  if (id === "max_resist") {
    const base = mobBaseStats(snapshot, lvl, balanceId);
    return {
      offence: mobOffence(snapshot, lvl, balanceId),
      level: lvl,
      // **Not** a boss's own armour. The dummy solves for a mitigation figure rather than
      // copying a rarity: `setArmourForMitigation(profile, playerLevel, 0.75F)`, which inverts
      // `value / (value + base)` to the armour number that stops three quarters of a physical
      // hit. A boss's `10 x 3.5` through the level curve is 728 at level 100 and stops 26%, so
      // reading this preset as "a boss with capped resists" understated physical mitigation by
      // a factor of three and made every physical build look better against it than it is.
      armor: armourForMitigation(snapshot, lvl, MAX_RESIST_MITIGATION, balanceId),
      // The dummy's Max Resist preset overrides armour and the resists and leaves everything
      // else MnS's, so the base block's dodge comes along exactly as it does for a rarity.
      dodge: base["dodge"] ?? 0,
      spellDodge: base["spell_dodge"] ?? 0,
      resists: filledResists(RESIST_HARD_CAP),
      // `max_<element>_resist` is an **addition above the 75% base cap**, not the cap itself:
      // `clamp(75 + getAdditionalMax(unit), min, 90)` in `ElementalResist.getUsableValue`. The
      // stat's own `max` is 15, which is exactly what reaches the 90 hard cap — so 15 is the
      // number, and the 90 that used to sit here was a value no character or mob can hold.
      maxResists: filledResists(MAX_ELEMENTAL_RESIST_STAT_MAX),
    };
  }

  // `setRarity` in the dummy checks the multiplier before using the rarity and falls back to
  // common; the same check here is what keeps a pack that dropped a rarity from silently
  // producing a naked target.
  const rarityId = targetPreset(id)?.rarityId ?? RARITY.common;
  const multi = rarityStatMultiplier(snapshot, rarityId) ?? 1;
  const flat = MOB_BASE_STAT * multi;
  const base = mobBaseStats(snapshot, lvl, balanceId);

  return {
    level: lvl,
    armor: scaledArmour(snapshot, multi, lvl, balanceId) + (base["armor"] ?? 0),
    dodge: base["dodge"] ?? 0,
    spellDodge: base["spell_dodge"] ?? 0,
    // `ExactStatData.noScaling` — the same flat number at every level, and no physical entry,
    // because `getAllSingle()` is iterated with `Physical` skipped. The base block's own
    // resists land on top, which is the half that used to be missing.
    resists: filledResists(flat, base),
    offence: mobOffence(snapshot, lvl, balanceId),
  };
}

/**
 * `mmorpg_base_stats/mob` — the block `CommonStatUtils.addBaseStats` gives every non-player.
 *
 * This is the half of a mob's stat block that is **not** in `MobStatUtils.getMobBaseStats`, and
 * leaving it out was why every preset here disagreed with the Training Dummy standing in the
 * player's own world. Craft to Exile 2 overrides the jar's entry with a substantial one:
 *
 *     armor            15  scaled      dodge              20  scaled
 *     spell_dodge      15  scaled      elemental_resist   10  flat
 *     chaos_resist     10  flat        accuracy            8  scaled
 *     armor_penetration 6  scaled      critical_damage   -50  flat
 *     all_elemental_damage 50 flat     all_chaos_damage   50  flat
 *
 * Add it to the rarity's `10 x stat_multi` and the four numbers a player reads off an Epic
 * dummy at level 100 come out exactly: armour `(15 + 19) x 20.8 = 707`, dodge `20 x 20.8 = 416`,
 * spell dodge `15 x 20.8 = 312`, and every resist `10 + 19 = 29`. Before this the same preset
 * said 395 armour, no dodge at all and 19 resist.
 *
 * `elemental_resist` is spread here rather than carried as itself: `ElementalResist`'s
 * generated family transfers it to fire, water and lightning and **not** to chaos, which is why
 * the pack has to name `chaos_resist` separately to give a mob all four.
 */
function mobBaseStats(snapshot: Snapshot, level: number, balanceId?: string): Record<string, number> {
  const curve = normalScaling(snapshot, balanceId);
  const lvl = curve.capToMaxLvl ? Math.min(Math.max(level, 1), curve.maxLevel) : level;
  const scale = curve.baseScaling + curve.perLevelScaling * (lvl - 1);

  const out: Record<string, number> = {};
  const data = entry(snapshot, CATEGORY.baseStats, MOB_BASE_STATS_ID)?.data;
  const raw = data?.["base_stats"];
  if (!Array.isArray(raw)) return out;

  for (const mod of raw) {
    if (mod === null || typeof mod !== "object") continue;
    const m = mod as Record<string, unknown>;
    // The block is all `FLAT`; a `PERCENT` entry would be a multiplier on a stat this preset
    // has not computed yet, so it is left for the engine rather than guessed at here.
    if (String(m["type"] ?? "FLAT").toUpperCase() !== "FLAT") continue;
    const statId = typeof m["stat"] === "string" ? m["stat"] : undefined;
    const v1 = typeof m["v1"] === "number" ? m["v1"] : undefined;
    if (statId === undefined || v1 === undefined) continue;

    const value = m["scale_to_lvl"] === true ? v1 * scale : v1;
    if (statId === "elemental_resist") {
      for (const guid of ELEMENTAL_RESIST_FAMILY) out[guid] = (out[guid] ?? 0) + value;
      continue;
    }
    out[statId] = (out[statId] ?? 0) + value;
  }
  return out;
}

/**
 * `CODE_ONLY_TRANSFERS["elemental_resist"]` — fire, water and lightning, and not chaos.
 *
 * Written out rather than imported so this file stays a statement of the preset arithmetic;
 * the engine's table is the same three and is what the damage pipeline reads.
 */
const ELEMENTAL_RESIST_FAMILY = ["fire_resist", "water_resist", "lightning_resist"] as const;

/**
 * What `MobStatUtils.getMobBaseStats` gives a mob to hit you *with*.
 *
 *     stats.add(ExactStatData.scaleTo(1, ModType.FLAT, OffenseStats.ACCURACY.get().GUID(), lvl));
 *
 * One line, verified in 6.4.13: accuracy on the same `NORMAL_STAT_SCALING` curve as armour. Rarity
 * does not touch it: `MobRarity.stats` in this pack carries only
 * `inc_effect_of_negative_buff_on_you`. The rest comes from `mmorpg_base_stats/mob` — 8 more
 * accuracy, 6 armour penetration, and 50% more damage on elemental and chaos hits.
 *
 * So the zeroes left here are a finding rather than a placeholder. A mob that penetrates your
 * resists is one carrying a map affix, a mob affix or an entity config that says so, and those
 * are stated elsewhere — the preset would be inventing them.
 */
function mobOffence(snapshot: Snapshot, level: number, balanceId?: string): MobOffence {
  const curve = normalScaling(snapshot, balanceId);
  const lvl = curve.capToMaxLvl ? Math.min(Math.max(level, 1), curve.maxLevel) : level;
  const base = mobBaseStats(snapshot, lvl, balanceId);
  return {
    // `getMobBaseStats` scales 1 to the level; `mmorpg_base_stats/mob` scales 8 more onto the
    // same curve, so a mob's accuracy is nine times what this used to report.
    accuracy: curve.baseScaling + curve.perLevelScaling * (lvl - 1) + (base["accuracy"] ?? 0),
    // Not zero any more. The pack's block carries `armor_penetration 6` scaled, which is real
    // mitigation coming off the player's armour and was previously being thrown away.
    armorPenetration: base["armor_penetration"] ?? 0,
    penetration: zeroResists(),
    // `all_elemental_damage 50` and `all_chaos_damage 50`, flat. Additive damage on a hit of
    // that element only, which is why it is carried per element rather than folded into one
    // `totalDamage` — a mob's fire hit is half again its physical one.
    elementDamage: elementDamageOf(base),
    critChance: 0,
  };
}

/** Every `all_<element>_damage` in the base block, keyed by the element guid. */
function elementDamageOf(base: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [statId, value] of Object.entries(base)) {
    const match = /^all_(\w+)_damage$/.exec(statId);
    if (match?.[1] !== undefined && value !== 0) out[match[1]] = value;
  }
  return out;
}

/** Which rarities the snapshot actually has, for a picker that should not offer a dead one. */
export function availableRarities(snapshot: Snapshot): string[] {
  return ids(snapshot, CATEGORY.mobRarity);
}

/**
 * `MobRarity.StatMultiplier()`, or undefined when the pack has no such rarity.
 *
 * Checked rather than assumed because a modpack may drop a rarity; the dummy's `setRarity`
 * does the same check for the same reason, and falls back to common.
 */
function rarityStatMultiplier(snapshot: Snapshot, rarityId: string): number | undefined {
  const data = entry(snapshot, CATEGORY.mobRarity, rarityId)?.data;
  const value = data?.["stat_multi"];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * `ExactStatData.scaleTo(value, FLAT, Armor.GUID, level)` — the `NORMAL_STAT_SCALING` curve.
 *
 * `getMultiFor(lvl)` is `base_scaling + per_level_scaling * (lvl - 1)`, and `original_balance`
 * leaves `NORMAL` uncapped, so it keeps climbing past the level cap.
 */
function scaledArmour(snapshot: Snapshot, statMulti: number, level: number, balanceId?: string): number {
  const curve = normalScaling(snapshot, balanceId);
  const lvl = curve.capToMaxLvl ? Math.min(Math.max(level, 1), curve.maxLevel) : level;
  return MOB_BASE_STAT * statMulti * (curve.baseScaling + curve.perLevelScaling * (lvl - 1));
}

/**
 * The armour number that buys a given fraction of physical mitigation, at a level.
 *
 * `ArmorEffect` turns armour into a percentage with `value / (value + base)`, where `base` is
 * `valueNeededToReachMaximumPercentAtLevelOne` put through the NORMAL curve. Inverting it is
 * `base * m / (1 - m)`, so the preset means the same thing at every level — which is the point:
 * the dummy's own comment says a level 20 and a level 90 need different armour numbers for the
 * same "half your physical damage".
 *
 * The level inverted against is the **attacker's**. `ArmorEffect` reads `sourceData.getLevel()`,
 * never the target's, so a target pinned above the character would otherwise mitigate more than
 * the preset claims.
 */
function armourForMitigation(
  snapshot: Snapshot,
  level: number,
  mitigation: number,
  balanceId?: string,
): number {
  const curve = normalScaling(snapshot, balanceId);
  const lvl = curve.capToMaxLvl ? Math.min(Math.max(level, 1), curve.maxLevel) : level;
  const base = ARMOUR_AT_LEVEL_ONE * (curve.baseScaling + curve.perLevelScaling * (lvl - 1));
  // `Math.min(mitigation, armor.getMaxMulti() - 0.001F)` — the asymptote is never reached, and
  // without the epsilon a caller asking for 0.9 would divide by zero.
  const capped = Math.min(mitigation, ARMOUR_MAX_MULTI - 0.001);
  return (base * capped) / (1 - capped);
}

type Curve = { baseScaling: number; perLevelScaling: number; capToMaxLvl: boolean; maxLevel: number };

function normalScaling(snapshot: Snapshot, balanceId?: string): Curve {
  const data = entry(snapshot, CATEGORY.gameBalance, balanceId ?? "original_balance")?.data ?? {};
  const maxLevel = typeof data["MAX_LEVEL"] === "number" ? data["MAX_LEVEL"] : 100;
  const node = data["NORMAL_STAT_SCALING"];
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    // `GameBalanceConfig`'s own field initialiser.
    return { baseScaling: 1, perLevelScaling: 0.2, capToMaxLvl: false, maxLevel };
  }
  const n = node as Record<string, unknown>;
  return {
    baseScaling: typeof n["base_scaling"] === "number" ? n["base_scaling"] : 1,
    perLevelScaling: typeof n["per_level_scaling"] === "number" ? n["per_level_scaling"] : 0.2,
    capToMaxLvl: n["cap_to_max_lvl"] === true,
    maxLevel,
  };
}

/**
 * Every single element but Physical, which no mob has a resistance to.
 *
 * `base` is the resolved `mmorpg_base_stats/mob` block, whose resists are keyed by stat id
 * (`fire_resist`) where an `EnemySetup` is keyed by element guid (`fire`). Omitted by the two
 * callers that are stating a number outright rather than building a mob.
 */
function filledResists(value: number, base?: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const element of SINGLE_ELEMENTS) {
    if (element.name === "Physical") continue;
    out[element.guid] = value + (base?.[`${element.guid}_resist`] ?? 0);
  }
  return out;
}

/** Physical included here: Naked zeroes everything, and a zero it does not have reads 0 anyway. */
function zeroResists(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const element of SINGLE_ELEMENTS) out[element.guid] = 0;
  return out;
}
