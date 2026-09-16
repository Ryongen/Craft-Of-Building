/**
 * Stat modifiers: the two shapes the registries use, and how each becomes a number.
 *
 * Walking every entry of the 2.0.2 snapshot turns up 5,747 modifier objects and exactly two
 * key signatures:
 *
 *   `{ type, stat, min, max }`            3,642  affixes, gear bases, uniques, spells,
 *                                                support gems, runes, runewords, auras,
 *                                                exile effects, map/mob affixes, omens
 *   `{ type, stat, v1, scale_to_lvl }`    2,105  perks, base stats, gems, entities,
 *                                                `core_stat_data`
 *
 * The first is `StatModifier` — a range an item rolls within. The second is `OptScaleExactStat`
 * — a fixed value that may or may not scale with the holder's level. Both end up as an
 * `ExactStatData`, which is what the container consumes.
 */

import type { Balance } from "./balance.js";
import type { StatShape } from "./stat-shape.js";

/**
 * `ModType`. Note the resolution rule, which the pack leans on:
 *
 *     for (ModType type : ModType.values()) {
 *         if (type.id.toLowerCase(Locale.ROOT).equals(str.toLowerCase(Locale.ROOT))) { return type; }
 *     }
 *     try { ModType TYPE = valueOf(str); ... } catch (IllegalArgumentException e) { ... }
 *     return FLAT;
 *
 * — ModType.java:37-54. Case-insensitive, and **anything unrecognised becomes FLAT** rather
 * than erroring. This pack ships 281 `"flat"`, 55 `"percent"` and one `"more"` in lowercase
 * alongside the uppercase spellings, sometimes in the same `stats` array.
 */
export const MOD_TYPES = ["FLAT", "PERCENT", "MORE"] as const;
export type ModType = (typeof MOD_TYPES)[number];

export function modTypeFromString(raw: string): ModType {
  const upper = raw.toUpperCase();
  return (MOD_TYPES as readonly string[]).includes(upper) ? (upper as ModType) : "FLAT";
}

/** Whether a modifier type was spelled in a way the game recognises at all. */
export function isKnownModType(raw: string): boolean {
  return (MOD_TYPES as readonly string[]).includes(raw.toUpperCase());
}

/** `ExactStatData` — a resolved modifier, ready to enter the container. */
export type ExactMod = {
  statId: string;
  type: ModType;
  value: number;
  /**
   * Which part of the source produced it.
   *
   * A `GEAR` context is one item, and one item is a base, up to six affixes, an enchant, a
   * handful of corruptions, its runes and possibly a runeword — all merged into one list under
   * the item's base id. That merge is right for the arithmetic and wrong for the reader: "this
   * chest gave you +412 armour" is not the answer to where the armour came from when the chest
   * has two armour affixes and a base roll. This says which part, so the breakdown can name the
   * affix and its roll instead of the item.
   *
   * Optional because most collectors have nothing more specific to say than the context already
   * does — a talent context *is* the talent.
   */
  from?: ModOrigin;
};

/** What part of an item, jewel or rune produced a modifier. */
export type ModOrigin = {
  /** Which list it came off. `base` is the item's own `base_stats`. */
  kind: "base" | "implicit" | "prefix" | "suffix" | "corruption" | "enchant" | "unique" | "rune" | "runeword";
  /** The registry id of the part — an `mmorpg_affixes`, `mmorpg_runes` or unique id. */
  id?: string;
  /** The percent the roll resolved at, 0-100. The number no player can read in game. */
  rollPercent?: number;
  /** The affix's own rarity, which is what the game calls its tier. */
  tier?: string;
};

/** `StatModifier`: a range, resolved by a roll percent. */
export type RolledMod = {
  statId: string;
  type: ModType;
  min: number;
  max: number;
};

/** `OptScaleExactStat`: a fixed value, optionally scaled to the holder's level. */
export type SourceMod = {
  statId: string;
  type: ModType;
  v1: number;
  scaleToLvl: boolean;
};

export function parseRolledMod(node: Record<string, unknown>): RolledMod | undefined {
  const statId = node["stat"];
  const type = node["type"];
  const min = node["min"];
  const max = node["max"];
  if (typeof statId !== "string" || typeof type !== "string") return undefined;
  if (typeof min !== "number" || typeof max !== "number") return undefined;
  return { statId, type: modTypeFromString(type), min, max };
}

export function parseSourceMod(node: Record<string, unknown>): SourceMod | undefined {
  const statId = node["stat"];
  const type = node["type"];
  const v1 = node["v1"];
  if (typeof statId !== "string" || typeof type !== "string" || typeof v1 !== "number") {
    return undefined;
  }
  return {
    statId,
    type: modTypeFromString(type),
    v1,
    scaleToLvl: node["scale_to_lvl"] === true,
  };
}

/** Reads every modifier of one shape out of a raw `stats`-style array. */
export function parseRolledMods(nodes: readonly Record<string, unknown>[]): RolledMod[] {
  return nodes.map(parseRolledMod).filter((m): m is RolledMod => m !== undefined);
}

export function parseSourceMods(nodes: readonly unknown[]): SourceMod[] {
  return nodes
    .filter((n): n is Record<string, unknown> => n !== null && typeof n === "object" && !Array.isArray(n))
    .map(parseSourceMod)
    .filter((m): m is SourceMod => m !== undefined);
}

/**
 * Level scaling.
 *
 *     public final float scale(ModType mod, float stat, float lvl) {
 *         if (mod.isFlat()) { return getScaling().scale(stat, lvl); }
 *         return stat;
 *     }
 *
 * — Stat.java:197-202. **Only FLAT scales.** A PERCENT or MORE modifier is the same number at
 * level 1 and level 100, which is why levelling a character raises flat life and armor but
 * never the "+20% increased" lines.
 */
export function levelScale(
  type: ModType,
  value: number,
  level: number,
  shape: StatShape,
  bal: Balance,
): number {
  if (type !== "FLAT") return value;
  return value * bal.multiFor(shape.scaling, level);
}

/**
 * A rolled modifier at a given roll percent and level.
 *
 *     data.v1 = (mod.min + (mod.max - mod.min) * percent / 100F);
 *     data.type = mod.getModType();
 *     data.stat = mod.stat;
 *     data.scaleToLevel(lvl);
 *
 * — `ExactStatData.fromStatModifier`, ExactStatData.java:48-59.
 */
export function rollToExact(
  mod: RolledMod,
  rollPercent: number,
  level: number,
  shape: StatShape,
  bal: Balance,
): ExactMod {
  const raw = mod.min + ((mod.max - mod.min) * rollPercent) / 100;
  return { statId: mod.statId, type: mod.type, value: levelScale(mod.type, raw, level, shape, bal) };
}

/**
 * A fixed modifier at the holder's level.
 *
 * `scale_to_lvl` decides whether the level is the holder's or 1 — `BonusStatPerEffectStacks`
 * spells it out as `x.scale_to_lvl ? data.getLevel() : 1` (BonusStatPerEffectStacks.java:73-79),
 * and level 1 with any curve is a multiplier of `base_scaling`, i.e. 1 in this pack.
 */
export function sourceToExact(
  mod: SourceMod,
  level: number,
  shape: StatShape,
  bal: Balance,
): ExactMod {
  const lvl = mod.scaleToLvl ? level : 1;
  return { statId: mod.statId, type: mod.type, value: levelScale(mod.type, mod.v1, lvl, shape, bal) };
}

/** `ExactStatData.multiplyBy` — used where a source contributes at partial strength. */
export function multiplyExact(mod: ExactMod, multi: number): ExactMod {
  return { ...mod, value: mod.value * multi };
}
