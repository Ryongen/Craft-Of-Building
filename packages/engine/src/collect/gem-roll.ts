/**
 * The roll a skill-gem-type item's stats are interpolated at.
 *
 * Shared by support gems and Augments because the game stores both as `SkillGemData`, and both
 * resolve their stats the same way — `GetAllStats(en, data)` reads `data.getStatPercent()` and
 * nothing else.
 *
 * The part worth having in one place is what to do when a document does not state the roll.
 * Zero is the wrong answer whenever the rarity *is* known: a gem's percent is drawn from its
 * rarity's band and stays there —
 *
 *     data.rar  = rar.GUID();
 *     data.perc = rar.stat_percents.random();
 *
 * — SkillGemBlueprint.java:32-40 — so a mythic gem is at least 86%, and computing it at 0%
 * describes an item the game cannot make. This is the same rule `collectItem` already applies
 * to a gear base whose rolls are missing: fall to the band's floor, which is the weakest thing
 * of that rarity that could actually exist, rather than to a number below every one of them.
 */

import { CATEGORY, entry, gearRarity } from "@cte2/schema";

import type { Env } from "../context.js";

export type GemRoll = {
  /** The percent to interpolate at. */
  percent: number;
  /** Whether that came from the document, as opposed to being floored. */
  stated: boolean;
  /** The floor used when it was not stated, for the diagnostic to quote. */
  floor: number;
};

export function gemRoll(env: Env, rarityId: string | undefined, rollPercent: number | undefined): GemRoll {
  const floor = bandFloor(env, rarityId);
  if (rollPercent === undefined) return { percent: floor, stated: false, floor };
  return { percent: rollPercent, stated: true, floor };
}

function bandFloor(env: Env, rarityId: string | undefined): number {
  if (rarityId === undefined) return 0;
  // A rarity the snapshot does not have is reported by the validator, not here; the engine just
  // declines to invent a floor for it.
  const view = gearRarity(env.snapshot, rarityId);
  if (!view || entry(env.snapshot, CATEGORY.gearRarity, rarityId) === undefined) return 0;
  return view.statPercents.min;
}
