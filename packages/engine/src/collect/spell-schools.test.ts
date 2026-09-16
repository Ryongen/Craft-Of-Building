/**
 * Spell school allocations, and the three things about them that are easy to get wrong: the
 * level multiplier, the solo-class bonus, and that a spell's rank is a stat like any other.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { BuildDoc } from "@cte2/schema";

import { calculate } from "../calculate.js";
import { closeTo, damageStat, engineSnapshot, exact, statEntry } from "../test-support.js";

function build(level: number, schools?: Record<string, number>): BuildDoc {
  return {
    schemaVersion: 1,
    character: schools === undefined ? { level } : { level, schools },
  };
}

function perkEntry(id: string, stats: Record<string, unknown>[], maxLevels = 20) {
  return { id, type: "STAT", is_entry: false, max_lvls: maxLevels, stats };
}

/**
 * One school with a passive on row 0 and a spell on row 3, plus a second school so the
 * solo-class rule has something to stop being true about.
 */
function snapshot() {
  return engineSnapshot({
    mmorpg_stat: {
      attack_speed: statEntry("attack_speed"),
      health: statEntry("health", { scaling: "NORMAL" }),
      // MULTIPLICATIVE_DAMAGE in the real registry (`setUsesMoreMultiplier`), which is why
      // the solo bonus lands in dmgMulti rather than in the value.
      total_damage: damageStat("total_damage", { scaling: "NONE" }),
      dmg_reduction: statEntry("dmg_reduction", { scaling: "NONE", is_perc: true }),
      learn_fireball: statEntry("learn_fireball"),
    },
    mmorpg_perk: {
      p_speed: perkEntry("p_speed", [exact("attack_speed", "FLAT", 9)], 8),
      fireball: perkEntry("fireball", [exact("learn_fireball", "FLAT", 1)], 20),
      p_health_scaled: perkEntry("p_health_scaled", [exact("health", "FLAT", 10, true)], 8),
      // In a second school, so allocating it costs the solo-class bonus.
      other_passive: perkEntry("other_passive", [exact("attack_speed", "FLAT", 1)], 8),
    },
    mmorpg_spell_school: {
      brawler: {
        id: "brawler",
        lvl_reqs: [1, 5, 10, 15, 20, 25, 30],
        perks: {
          p_speed: { x: 0, y: 0 },
          fireball: { x: 1, y: 3 },
          p_health_scaled: { x: 2, y: 0 },
        },
      },
      sorcerer: {
        id: "sorcerer",
        lvl_reqs: [1, 5, 10, 15, 20, 25, 30],
        perks: { other_passive: { x: 0, y: 0 } },
      },
    },
  });
}

test("a perk at level N grants N times its stats", () => {
  // `percentIncrease = (lvl - 1) * 100`, then `v1 *= (1 + percentIncrease / 100)`. Six levels
  // of a 9 attack speed passive is 54, not 9 and not 9 * 1.05^5.
  const result = calculate(build(50, { p_speed: 6 }), snapshot());
  closeTo(result.stats.get("attack_speed")?.value, 54);
});

test("level one is the listed value, not double it", () => {
  const result = calculate(build(50, { p_speed: 1 }), snapshot());
  closeTo(result.stats.get("attack_speed")?.value, 9);
});

test("the multiplier applies on top of level scaling, not instead of it", () => {
  // `toExactStat(level)` runs first and the multiplier follows, so a scale_to_lvl stat is
  // multiplied after scaling. Whatever one level is worth, three levels is three times it.
  const one = calculate(build(60, { p_health_scaled: 1 }), snapshot()).stats.get("health")?.value;
  const three = calculate(build(60, { p_health_scaled: 3 }), snapshot()).stats.get("health")?.value;
  assert.ok(one !== undefined && three !== undefined);
  assert.ok(one > 10, `expected level scaling to raise 10, got ${one}`);
  closeTo(three, one * 3);
});

test("a spell perk's level is the spell's rank, as a stat on the sheet", () => {
  // `SpellCastingData.calcSpellLevels` reads `learn_<spell>` back out of the container, so this
  // is the whole of how a spell gets its level from an allocation.
  const result = calculate(build(50, { fireball: 7 }), snapshot());
  closeTo(result.stats.get("learn_fireball")?.value, 7);
});

test("one school pays the solo-class bonus", () => {
  const result = calculate(build(50, { p_speed: 1 }), snapshot());
  closeTo(result.stats.get("dmg_reduction")?.value, 5);
  closeTo(result.stats.get("total_damage")?.dmgMulti, 1.1);
});

test("a second school costs it", () => {
  const result = calculate(build(50, { p_speed: 1, other_passive: 1 }), snapshot());
  assert.equal(result.stats.get("dmg_reduction")?.value ?? 0, 0);
  closeTo(result.stats.get("total_damage")?.dmgMulti ?? 1, 1);
});

test("the bonus is keyed on schools, not on perk count", () => {
  // Three perks, one school: still solo.
  const result = calculate(build(50, { p_speed: 1, fireball: 1, p_health_scaled: 1 }), snapshot());
  closeTo(result.stats.get("dmg_reduction")?.value, 5);
});

test("the solo bonus is its own context, so nothing scaling passives can reach it", () => {
  const result = calculate(build(50, { p_speed: 1 }), snapshot());
  const solo = result.contexts.find((c) => c.source === "solo_class_bonus");
  assert.ok(solo, "expected a solo_class_bonus context");
  assert.equal(solo.type, "MISC");
  assert.ok(
    result.contexts.some((c) => c.type === "PASSIVES" && c.source === "p_speed"),
    "expected the perk itself to be in a PASSIVES context",
  );
});

test("a row's level requirement is reported, not silently applied", () => {
  // `canLearn` gates this at allocation time, so the stats still land; the document is what is
  // wrong, and the diagnostic is what says so.
  const result = calculate(build(9, { fireball: 1 }), snapshot());
  closeTo(result.stats.get("learn_fireball")?.value, 1);
  assert.ok(
    result.diagnostics.some((d) => d.code === "school-row-level-too-low" && d.severity === "error"),
    "expected a row level diagnostic",
  );
});

test("a level past max_lvls is an error", () => {
  const result = calculate(build(50, { p_speed: 9 }), snapshot());
  assert.ok(result.diagnostics.some((d) => d.code === "school-perk-over-max"));
});

test("an unknown perk grants nothing and says so", () => {
  const result = calculate(build(50, { not_a_perk: 3 }), snapshot());
  assert.ok(result.diagnostics.some((d) => d.code === "unknown-school-perk"));
});
