/**
 * The parts of the code-only stats that are behaviour rather than constants.
 *
 * `tools/port-code-only-stats.mjs` reads `min`, `max`, `scaling` and friends out of the Java
 * automatically because they are plain field assignments. What is left is overridden methods,
 * which have to be read and re-stated by hand. There are only three of them, and each is
 * quoted at its call site below.
 *
 * Source throughout: mahjerion/Mine-And-Slash-Rework @ `1.20-Forge`.
 */

import type { CtxType } from "./context.js";
import type { StatShape } from "@cte2/schema";

/**
 * Which stats hand themselves to others (`ITransferToOtherStats`, applied by `InCalc.modify`,
 * InCalc.java:28-33) is generated rather than written here — see `CODE_ONLY_TRANSFERS`.
 *
 *     public void transferStats(InCalcStatContainer unit, InCalcStatData thisstat) {
 *         if (this.element == Elements.Elemental) {
 *             for (Elements ele : Elements.getAllSingleElemental()) {
 *                 thisstat.addFullyTo(unit.getStatInCalculation(newGeneratedInstance(ele)));
 *             }
 *             thisstat.clear();
 *         }
 *     }
 *
 * — ElementalStat.java:45-52, with `AllAttributes` doing the same into the three core stats.
 * The list is generated because which families even have an `Elemental` variant cannot be
 * guessed: `phys_to_elemental` and `max_elemental_resist` exist, `elemental_weapon_damage`
 * does not, and all three come from `ElementalStat` subclasses.
 *
 * Note the consequence for the character sheet: `elemental_resist` reads 0 after a
 * calculation however much of it you have, because `clear()` empties the source once it has
 * been handed on. A fixture showing a non-zero `elemental_resist` would mean this is wrong.
 */

/**
 * `IUsableStat` — the diminishing-returns curve behind the stat sheet's `usable_value`
 * column, which is how 100 armor becomes a mitigation percentage.
 *
 *     float base = scaledvalueNeededToReachMaximumPercentAtLevelOne(lvl);
 *     float val = value / (value + base);
 *     return MathHelper.clamp(val, 0F, getMaxMulti());
 *
 * — IUsableStat.java:26-36, with `value` floored at 0 and truncated to an int by the caller.
 * `base` is the level-scaled form of the constant, using the stat's own `StatScaling`.
 *
 * Four classes implement it. `ElementalResist` overrides the formula outright.
 */
export type UsableStat =
  | { kind: "curve"; maxMulti: number; valueNeededAtLevelOne: number }
  /** `maxStat` is the `MaxElementalResist` that raises this resist's ceiling above 75. */
  | { kind: "resist"; maxStat: string }
  /**
   * `BlockChance.getUsableValue`, which is a resist's shape with one difference:
   *
   *     return MathHelper.clamp((float) value, this.min, BASE_BLOCK_CAP + getAdditionalMax(unit)) / 100F;
   *
   * `BASE_BLOCK_CAP` is 75 like a resist's, and `getAdditionalMax` is `max_block_chance` — but
   * there is **no outer clamp to 90**. A resist computes its ceiling as
   * `clamp(75 + additional, min, 90)`; block chance does not, so enough `max_block_chance`
   * raises it past where any resist could go.
   */
  | { kind: "block"; maxStat: string };

export const USABLE_STATS: Record<string, UsableStat> = {
  // Armor.java:53-60
  armor: { kind: "curve", maxMulti: 0.9, valueNeededAtLevelOne: 100 },
  // DodgeRating.java:66-73
  dodge: { kind: "curve", maxMulti: 0.8, valueNeededAtLevelOne: 100 },
  // SpellDodge.java:51-58
  spell_dodge: { kind: "curve", maxMulti: 0.9, valueNeededAtLevelOne: 200 },

  // `ElementalResist` overrides the curve outright (ElementalResist.java:114-119):
  //
  //     public float getUsableValue(Unit unit, int value, int lvl) {
  //         float max = MathHelper.clamp(75 + this.getAdditionalMax(unit), min, 90);
  //         float min = this.min;
  //         return MathHelper.clamp(value, min, max) / 100F;
  //     }
  //
  // The ceiling is **75, not the stat's own `max` of 500** — raised by that element's
  // `MaxElementalResist` (`getAdditionalMax`, ElementalResist.java:73-76) and hard-capped at
  // 90. Phase 1 clamped to the stat shape's `max` instead, which reported 100% mitigation for
  // a 100% resist; the game reports 75%. `Stat.getCap()` also calls `getAdditionalMax` and
  // *is* unreachable, since nothing sets `has_softcap` — but this call site is not that one.
  //
  // One id per `Elements` value, since `generateAllPossibleStatVariations` runs over all of
  // them. Listed rather than matched on `_resist`, which would wrongly catch the
  // `max_<element>_resist` stats — those are `MaxElementalResist`, which is not an
  // `IUsableStat`.
  physical_resist: { kind: "resist", maxStat: "max_physical_resist" },
  fire_resist: { kind: "resist", maxStat: "max_fire_resist" },
  water_resist: { kind: "resist", maxStat: "max_water_resist" },
  lightning_resist: { kind: "resist", maxStat: "max_lightning_resist" },
  chaos_resist: { kind: "resist", maxStat: "max_chaos_resist" },
  elemental_resist: { kind: "resist", maxStat: "max_elemental_resist" },
  block_chance: { kind: "block", maxStat: "max_block_chance" },
  all_resist: { kind: "resist", maxStat: "max_all_resist" },
};

/** `ElementalResist.getUsableValue`'s two constants. */
export const RESIST_BASE_CAP = 75;
export const RESIST_HARD_CAP = 90;

/** `BlockChance.BASE_BLOCK_CAP`. Same number as a resist's floor cap, different rule above it. */
export const BLOCK_BASE_CAP = 75;

/**
 * Stat families whose ids come from a datapack registry instead of from the mod.
 *
 *     public String GUID() {
 *         return "learn_" + spell.GUID();
 *     }
 *
 * — LearnSpellStat.java:31-33, constructed with a `Spell`, so one exists per registered
 * spell. That makes them invisible to everything else: the extractor sees no JSON for them,
 * and the mod's own `modpack_dev_helper` list names only the jar's spells. Craft to Exile 2
 * adds 143 spells of its own, and enchants and perks all over the pack grant `learn_*` stats
 * for them. Without this they would each resolve to nothing.
 *
 * The shape comes from the generated table so there is one source of truth for it; only the
 * binding from class to registry is written here, because only Java says what it is.
 */
export const REGISTRY_FAMILIES: readonly {
  className: string;
  prefix: string;
  category: string;
}[] = [{ className: "LearnSpellStat", prefix: "learn_", category: "mmorpg_spells" }];

/**
 * Stats whose effect is a `statContextModifier`: they scale the stats of a whole context rather
 * than adding to a stat of their own, and each maps to the one `StatCtxType` it reaches
 * (`IStatCtxModifier.getCtxTypeNeeded`).
 *
 * Three stats in the game implement it — `AuraEffect`, `JewelEffect` and the `more_food_stats`
 * special stat — and the interface's default `modify` is the whole behaviour:
 *
 *     float multi = thisStat.getValue() / 100F;
 *     return target.getPercentOfStats(multi);
 *
 * `aura_effect` is the one that matters for a real build: 33% of it turns a 50% fire resist
 * aura into 66.5%, and every max-resist line the aura carries with it.
 */
export const CTX_MODIFIERS: Readonly<Record<string, CtxType>> = {
  aura_effect: "AURA",
  jewel_effect: "JEWEL",
  more_food_stats: "FOOD_BUFF",
};

export const CTX_MODIFIER_STATS: readonly string[] = Object.keys(CTX_MODIFIERS);

/**
 * Corrections to `code-only-stats.generated.ts` for the version skew between the source
 * checkout and the jar the pack actually loads.
 *
 * `tools/port-code-only-stats.mjs` reads constants out of a **source checkout** of
 * Mine and Slash. That checkout is at **6.4.8**; Craft to Exile 2 2.0.2 ships
 * **Mine_and_Slash-1.20.1-6.4.13.jar**, which `data/snapshot.json`'s own `meta` records. Five
 * patch releases of drift sit between them, and three stat classes changed their caps in it.
 *
 * Each correction below was read out of the 6.4.13 jar's bytecode (`javap -p -c`, constructor
 * field assignments — the same constants the porter reads from `.java` text) **and** is
 * independently confirmed by a capture, which is the stronger evidence: the mod writes
 * `hardcap` straight off the live registered `Stat.max`.
 *
 *  - `AilmentProcStat` gained `min = 0` and `max = 100`. 6.4.8 set only `is_perc`. Both
 *    captured fixtures observe `electrify_proc_chance` and `freeze_proc_chance` at hardcap
 *    100 against the table's "Inf".
 *  - `AilmentResistance` gained `max = 100`.
 *  - `BlockChance`'s `max` moved 75 -> 90. The level 100 capture observes 90.
 *
 * **This file is not where these belong long-term.** Point the porter at a 6.4.13 checkout
 * and regenerate, and every entry here should fall out as a no-op — `npm run port-stats`
 * rewrites the generated table, and nothing here is read unless it still disagrees. The
 * override is keyed by stat id rather than by class because the generated table records the
 * class only in a trailing comment.
 */
export const CODE_ONLY_SHAPE_OVERRIDES: Record<string, Partial<StatShape>> = {
  // AilmentProcStat — one per registered ailment.
  bleed_proc_chance: { min: 0, max: 100 },
  burn_proc_chance: { min: 0, max: 100 },
  electrify_proc_chance: { min: 0, max: 100 },
  freeze_proc_chance: { min: 0, max: 100 },
  poison_proc_chance: { min: 0, max: 100 },
  // AilmentResistance — likewise.
  bleed_resistance: { max: 100 },
  burn_resistance: { max: 100 },
  electrify_resistance: { max: 100 },
  freeze_resistance: { max: 100 },
  poison_resistance: { max: 100 },
  // BlockChance.
  block_chance: { max: 90 },
};
