/**
 * Support gem rolls.
 *
 * The thing under test is which percent reaches which support gem. The Java stores a Skill and
 * a support gem in one `SkillGemData` class and calls both "gem"; they are different items to a
 * player, and each support gem carries its own `perc`. `collectGemStats` hands each its own:
 *
 *     for (SkillGemData d : gem.getSupportDatas()) {
 *         statContexts.add(new SimpleStatCtx(SUPPORT_GEM, d.getSupport().GetAllStats(data, d)));
 *     }
 *
 * with `SupportGem.GetAllStats` reading `data.getStatPercent()` off that `d`. The Skill's own
 * percent is not involved at all — `Spell.getStats` derives its percent from the Skill's rank
 * and never looks at the item.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { BuildDoc, SkillSetup } from "@cte2/schema";

import { calculate } from "../calculate.js";
import { RARITIES, baseStats, closeTo, engineSnapshot, rolled, statEntry } from "../test-support.js";

const SNAPSHOT = engineSnapshot({
  mmorpg_stat: {
    crit_chance: statEntry("crit_chance"),
    melee_damage: statEntry("melee_damage"),
  },
  mmorpg_spells: {
    tailwind_sweep: { id: "tailwind_sweep", min_lvl: 1, max_lvl: 24, default_lvl: 1 },
  },
  mmorpg_support_gem: {
    crit_chance: { id: "crit_chance", stats: [rolled("crit_chance", "FLAT", 10, 30)] },
    melee_damage: { id: "melee_damage", stats: [rolled("melee_damage", "FLAT", 20, 40)] },
  },
  mmorpg_base_stats: { original_mode_player: baseStats("original_mode_player", []) },
  // The rarity ladder, because a gem's rarity is the band its roll is drawn from and the
  // engine declines to invent a floor for a rarity the snapshot does not have.
  mmorpg_gear_rarity: RARITIES,
});

function withSkill(skills: SkillSetup[]): BuildDoc {
  return { schemaVersion: 1, character: { level: 100 }, skills };
}

/** The engine only collects support gems for the skill it is asked about. */
function statsFor(doc: BuildDoc) {
  return calculate(doc, SNAPSHOT, { skill: doc.skills![0]! }).stats;
}

test("each support gem rolls at its own percent", () => {
  const stats = statsFor(
    withSkill([
      {
        spellId: "tailwind_sweep",
        level: 24,
        supports: [
          { id: "crit_chance", rollPercent: 100 },
          { id: "melee_damage", rollPercent: 0 },
        ],
      },
    ]),
  );
  closeTo(stats.get("crit_chance")?.value, 30);
  closeTo(stats.get("melee_damage")?.value, 20);
});

test("the Skill's own percent does not reach its support gems", () => {
  // `gemPercent` is the Skill item's roll, which buys nothing in game. A support gem that states
  // its own roll is unaffected by it — this is the bug that made a Skill which happened to roll
  // 33% quietly drag five perfectly rolled support gems down with it.
  const stats = statsFor(
    withSkill([
      {
        spellId: "tailwind_sweep",
        level: 24,
        gemPercent: 33,
        supports: [{ id: "crit_chance", rollPercent: 100 }],
      },
    ]),
  );
  closeTo(stats.get("crit_chance")?.value, 30);
});

test("a bare id inherits the skill's gemPercent, so old documents keep their numbers", () => {
  const stats = statsFor(
    withSkill([{ spellId: "tailwind_sweep", level: 24, gemPercent: 50, supports: ["crit_chance"] }]),
  );
  closeTo(stats.get("crit_chance")?.value, 20);
});

test("a support with no roll anywhere floors at zero and says so", () => {
  const doc = withSkill([{ spellId: "tailwind_sweep", level: 24, supports: ["crit_chance"] }]);
  const result = calculate(doc, SNAPSHOT, { skill: doc.skills![0]! });
  closeTo(result.stats.get("crit_chance")?.value, 10);
  assert.ok(result.diagnostics.some((d) => d.code === "gem-roll-unknown"));
});

test("two skills sharing a spell but not a support roll are calculated apart", () => {
  // The engine caches settled results per build; the key has to carry the rolls, or the second
  // read comes back with the first one's numbers.
  const doc: BuildDoc = {
    schemaVersion: 1,
    character: { level: 100 },
    skills: [
      { spellId: "tailwind_sweep", level: 24, supports: [{ id: "crit_chance", rollPercent: 0 }] },
      { spellId: "tailwind_sweep", level: 24, supports: [{ id: "crit_chance", rollPercent: 100 }] },
    ],
  };
  closeTo(calculate(doc, SNAPSHOT, { skill: doc.skills![0]! }).stats.get("crit_chance")?.value, 10);
  closeTo(calculate(doc, SNAPSHOT, { skill: doc.skills![1]! }).stats.get("crit_chance")?.value, 30);
});

test("a gem with no roll floors at its rarity's band, not at zero", () => {
  // `data.perc = rar.stat_percents.random()` — a mythic gem is drawn from 86..100 and never
  // leaves it, so computing an unrecorded one at 0% describes an item the game cannot make.
  // This is the rule `collectItem` already applies to a gear base whose rolls are missing.
  const stats = statsFor(
    withSkill([
      {
        spellId: "tailwind_sweep",
        level: 24,
        supports: [{ id: "crit_chance", rarity: "mythic" }],
      },
    ]),
  );
  // 10..30 at 86% = 27.2, against 10 if it had floored at zero.
  closeTo(stats.get("crit_chance")?.value, 10 + 20 * 0.86);
});

test("a stated roll wins over the band floor, and no rarity still means zero", () => {
  const stated = statsFor(
    withSkill([
      {
        spellId: "tailwind_sweep",
        level: 24,
        supports: [{ id: "crit_chance", rarity: "mythic", rollPercent: 95 }],
      },
    ]),
  );
  closeTo(stated.get("crit_chance")?.value, 10 + 20 * 0.95);

  const bare = statsFor(
    withSkill([{ spellId: "tailwind_sweep", level: 24, supports: [{ id: "crit_chance" }] }]),
  );
  closeTo(bare.get("crit_chance")?.value, 10);
});

// ---------------------------------------------------------------------------
// `use_support_gems_from` — the sockets move, they do not add
// ---------------------------------------------------------------------------

/**
 * `soul_wound` and `banishing_blade` in miniature. The proc borrows the weapon skill's sockets
 * and has none it could call its own.
 */
const BORROWED = engineSnapshot({
  mmorpg_stat: {
    crit_chance: statEntry("crit_chance"),
    melee_damage: statEntry("melee_damage"),
  },
  mmorpg_spells: {
    banishing_blade: { id: "banishing_blade", min_lvl: 1, max_lvl: 24, default_lvl: 1 },
    soul_wound: {
      id: "soul_wound",
      min_lvl: 1,
      max_lvl: 24,
      default_lvl: 1,
      config: { use_support_gems_from: "banishing_blade" },
    },
  },
  mmorpg_support_gem: {
    crit_chance: { id: "crit_chance", stats: [rolled("crit_chance", "FLAT", 10, 30)] },
    melee_damage: { id: "melee_damage", stats: [rolled("melee_damage", "FLAT", 20, 40)] },
  },
  mmorpg_base_stats: { original_mode_player: baseStats("original_mode_player", []) },
  mmorpg_gear_rarity: RARITIES,
});

test("a borrowing spell is supported by the lender's sockets, not its own", () => {
  // `PlayerData.getSpellUnitStats` builds the unit from a hotbar slot key and swaps that key for
  // the lender's when the spell borrows, so `collectGemStats` reads the lender's sockets. The
  // game's damage log is the proof: with `fortify` and `brutality` socketed into banishing_blade,
  // a Soul Wound hit prints multipliers the character sheet does not carry.
  const doc: BuildDoc = {
    schemaVersion: 1,
    character: { level: 100 },
    skills: [
      { spellId: "soul_wound", main: true, supports: [{ id: "crit_chance", rollPercent: 100 }] },
      { spellId: "banishing_blade", supports: [{ id: "melee_damage", rollPercent: 50 }] },
    ],
  };
  const stats = calculate(doc, BORROWED, { skill: doc.skills![0]! }).stats;

  closeTo(stats.get("melee_damage")?.value ?? 0, 30, "the lender's gem, at the lender's roll");
  assert.equal(
    stats.get("crit_chance")?.value ?? 0,
    0,
    "and its own socket is not consulted — the key is replaced, not added to",
  );
});

test("a borrowing spell whose lender is off the bar gets no support gems at all", () => {
  // `keyOf` returns SPELL_KEY_NOT_EXIST and `canHaveSpellUnit` is false, so there is no slot to
  // read. Falling back to the spell's own sockets would invent a unit the game never builds.
  const doc: BuildDoc = {
    schemaVersion: 1,
    character: { level: 100 },
    skills: [{ spellId: "soul_wound", main: true, supports: [{ id: "crit_chance", rollPercent: 100 }] }],
  };
  const stats = calculate(doc, BORROWED, { skill: doc.skills![0]! }).stats;

  assert.equal(stats.get("crit_chance")?.value ?? 0, 0);
  assert.equal(stats.get("melee_damage")?.value ?? 0, 0);
});
