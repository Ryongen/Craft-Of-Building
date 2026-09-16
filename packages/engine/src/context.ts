/**
 * Where a stat came from, and the shared state a collection pass needs.
 *
 * The game groups contributions into `StatContext`s and keeps them grouped all the way into
 * the container, because some stats modify a whole context rather than a stat
 * (`IStatCtxModifier` — "increased effect of your auras"). The engine keeps the grouping for
 * the same reason, and because the app will need to answer "where did this 340 armor come
 * from" without recomputing anything.
 */

import type { Snapshot } from "@cte2/extractor";
import type { Diagnostic, Severity } from "@cte2/schema";

import type { Balance } from "./balance.js";
import type { ExactMod } from "./modifier.js";
import type { StatIndex } from "./stat-def.js";

/**
 * `StatContext.StatCtxType`, minus the ones a build document cannot describe (mob affixes,
 * tools, bonus XP per character).
 */
export const CTX_TYPES = [
  "BASE_STAT",
  // The free elemental resists a character starts with and sheds at 25/50/75. Its own type in
  // the game too, so a breakdown can say "+50 of your fire resist is the newbie grant".
  "NEWBIE_RESISTS",
  "STAT_POINTS",
  "GEAR",
  "TALENT",
  "ASCENDANCY",
  // Spell school perks. `SpellSchoolsData.getStatAndContext` puts them here, and the solo-class
  // bonus deliberately goes to MISC instead so nothing scaling passives can reach it.
  "PASSIVES",
  "ATLAS",
  "JEWEL",
  "AURA",
  "POTION_EFFECT",
  "INNATE_SPELL",
  "SUPPORT_GEM",
  // `mmorpg_stat_compat` over vanilla attributes other mods set, converted into MnS stats. Its
  // own type in the game too (`StatCtxType.VANILLA_STAT_COMPAT`).
  "VANILLA_STAT_COMPAT",
  // The other half of `mmorpg_stat_compat`: vanilla enchantments on equipped gear. A separate
  // type in the game (`GearItemData.getEnchantCompatStats`), and separate here for the same
  // reason — Protection V is something the player put on a chestplate, not an attribute.
  "ENCHANT_COMPAT",
  // Meals, seafood and elixirs (`PlayerBuffData.getStatAndContext`). Temporary, but a character
  // is rarely without one, and `more_food_stats` exists to scale exactly this context.
  "FOOD_BUFF",
  // What `CtxStats.addStatCtxModifierStats` returns: the share of other contexts that
  // `aura_effect` and its two siblings add on top. Never scanned for modifiers itself — the
  // game builds it from the contexts that already exist and appends it afterwards.
  "STAT_CTX_MODIFIER_BONUS",
  "MISC",
] as const;

export type CtxType = (typeof CTX_TYPES)[number];

export type StatContext = {
  type: CtxType;
  /** The registry id that produced these — an item base, a perk, an aura. For provenance. */
  source: string;
  /** Document path the source came from, matching `@cte2/schema`'s diagnostic paths. */
  path: string;
  stats: ExactMod[];
};

/** Everything a collector needs, plus somewhere to put complaints. */
export type Env = {
  snapshot: Snapshot;
  index: StatIndex;
  balance: Balance;
  /** The character's level. Gear scales at the item's level, not this one. */
  level: number;
  diagnostics: Diagnostic[];
  report(severity: Severity, code: string, path: string, message: string): void;
};

export function makeEnv(
  snapshot: Snapshot,
  index: StatIndex,
  bal: Balance,
  level: number,
): Env {
  const diagnostics: Diagnostic[] = [];
  return {
    snapshot,
    index,
    balance: bal,
    level,
    diagnostics,
    report(severity, code, path, message) {
      diagnostics.push({ severity, code, path, message });
    },
  };
}

export function context(type: CtxType, source: string, path: string, stats: ExactMod[]): StatContext {
  return { type, source, path, stats };
}
