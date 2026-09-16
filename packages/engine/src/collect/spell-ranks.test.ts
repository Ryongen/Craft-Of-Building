/**
 * `SpellCastingData.calcSpellLevels` — what rank a spell is actually at.
 *
 * Two halves, and only the first is a property of the document. `learn_<spell>` is granted once
 * per perk level and *is* the rank; `MaxSpellLevel` and `MaxAllSpellLevels` then add bonus ranks
 * on top, and those are stats, so they are only knowable once the container has resolved.
 *
 * The arithmetic worth pinning is the clamp's position. The game clamps the *sum* of the bonus
 * and then adds it:
 *
 *     spell.bonus_ranks = MathHelper.clamp(spell.bonus_ranks, 0, MAX_BONUS_SPELL_LEVELS);
 *     spell.rank += spell.bonus_ranks;
 *
 * so a tagged spell and an untagged one carrying the same two stats end up at different ranks,
 * and neither ends up above its own ceiling.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { BuildDoc } from "@cte2/schema";

import { balance } from "../balance.js";
import { calculate } from "../calculate.js";
import { spellRanks } from "./spell.js";
import { baseStats, engineSnapshot, exact, statEntry } from "../test-support.js";

/** A spell entry with the tag list at the depth the pack nests it: `config.tags.tags`. */
function spell(id: string, tags: string[]): Record<string, unknown> {
  return { id, min_lvl: 1, max_lvl: 24, default_lvl: 0, config: { tags: { tags } } };
}

const STAT_IDS = [
  "learn_frostbolt",
  "learn_warcry",
  "learn_unslotted",
  "plus_lvl_all_spells",
  "plus_lvl_cold_spells",
];

const DOC: BuildDoc = { schemaVersion: 1, character: { level: 100 } };

/**
 * The ranks a character carrying exactly `stats` would end up with.
 *
 * Granted through the base stats rather than through gear because the source does not matter to
 * `calcSpellLevels` — it reads the finished container, so anything that reaches the sheet reaches
 * this. In game they come from perks, uniques and runewords.
 */
function ranksOf(stats: Record<string, number>): ReadonlyMap<string, number> {
  const snapshot = engineSnapshot({
    mmorpg_stat: Object.fromEntries(STAT_IDS.map((id) => [id, statEntry(id)])),
    mmorpg_spells: {
      frostbolt: spell("frostbolt", ["cold", "damage", "projectile"]),
      warcry: spell("warcry", ["buff", "shout"]),
      unslotted: spell("unslotted", ["cold"]),
    },
    mmorpg_base_stats: {
      original_mode_player: baseStats(
        "original_mode_player",
        Object.entries(stats).map(([id, value]) => exact(id, "FLAT", value)),
      ),
    },
  });
  return spellRanks(snapshot, calculate(DOC, snapshot).stats, balance(snapshot));
}

test("a spell's rank is its learn_ stat", () => {
  const ranks = ranksOf({ learn_frostbolt: 12 });
  assert.equal(ranks.get("frostbolt"), 12);
  // Nothing taught the other two, so `calcSpellLevels` never creates an InsertedSpell for them.
  assert.equal(ranks.has("warcry"), false);
  assert.equal(ranks.has("unslotted"), false);
});

test("MaxAllSpellLevels adds to every learned spell and MaxSpellLevel only to its tag", () => {
  const ranks = ranksOf({
    learn_frostbolt: 12,
    learn_warcry: 4,
    plus_lvl_all_spells: 2,
    plus_lvl_cold_spells: 2,
  });
  // `frostbolt` is tagged cold, so it takes both.
  assert.equal(ranks.get("frostbolt"), 16);
  // `warcry` is not, so it takes the `all` grant alone.
  assert.equal(ranks.get("warcry"), 6);
});

test("a tag nothing on the bar carries changes no rank", () => {
  assert.equal(ranksOf({ learn_warcry: 4, plus_lvl_cold_spells: 5 }).get("warcry"), 4);
});

test("bonus ranks are clamped before they are added, not after", () => {
  // MAX_BONUS_SPELL_LEVELS is 8 in `original_balance`. Six plus six is twelve, which clamps to
  // eight — a spell at 12 therefore reaches 20 rather than 24, and rather than 12 + 8 + 8.
  const ranks = ranksOf({ learn_frostbolt: 12, plus_lvl_all_spells: 6, plus_lvl_cold_spells: 6 });
  assert.equal(ranks.get("frostbolt"), 20);
});

test("a negative total cannot take a rank below what was learned", () => {
  // `clamp(bonus, 0, max)` has a floor as well as a ceiling, so a debuff that drove the sum
  // negative is discarded rather than subtracted.
  assert.equal(ranksOf({ learn_frostbolt: 12, plus_lvl_cold_spells: -4 }).get("frostbolt"), 12);
});

test("a learn_ stat that resolved to zero is not a spell the character knows", () => {
  assert.equal(ranksOf({ learn_unslotted: 0, plus_lvl_all_spells: 3 }).has("unslotted"), false);
});
