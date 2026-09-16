/**
 * Level-up points, and the one thing about them that surprises people: a point is worth the
 * same at level 100 as at level 2.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { BuildDoc } from "@cte2/schema";

import { calculate } from "../calculate.js";
import { baseStats, closeTo, coreStat, engineSnapshot, exact, statEntry } from "../test-support.js";

function build(level: number, statPoints?: Record<string, number>): BuildDoc {
  return {
    schemaVersion: 1,
    character: statPoints === undefined ? { level } : { level, statPoints },
  };
}

/**
 * Strength granting the two of its five real bundle entries that show the split cleanly: a
 * FLAT into health and a PERCENT into armour.
 */
function snapshot() {
  return engineSnapshot({
    mmorpg_stat: {
      strength: coreStat("strength", [
        exact("health", "FLAT", 2),
        exact("armor", "PERCENT", 0.25),
      ]),
      dexterity: coreStat("dexterity", [exact("dodge_rating", "FLAT", 1)]),
      health: statEntry("health", { scaling: "NORMAL" }),
      armor: statEntry("armor"),
      dodge_rating: statEntry("dodge_rating"),
    },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [exact("armor", "FLAT", 100)]),
    },
  });
}

test("one point is one point of the stat", () => {
  const result = calculate(build(50, { strength: 40 }), snapshot());
  closeTo(result.stats.get("strength")?.value, 40);
});

test("a point is worth the same at every level", () => {
  // `StatPointsData` passes a literal `1` to `ExactStatData.levelScaled`, and
  // `CORE_STAT_SCALING` at level 1 is `base_scaling + per_level * (1 - 1)` = 1. Levelling
  // grants more points; it never inflates the ones already spent.
  for (const level of [1, 2, 50, 100]) {
    const result = calculate(build(level, { strength: 10 }), snapshot());
    closeTo(result.stats.get("strength")?.value, 10, `strength at level ${level}`);
  }
});

test("the points feed the core stat bundle, in the pass that already exists", () => {
  // 40 strength grants 2 health each and 0.25% armour each: +80 health, +10% armour on 100.
  const result = calculate(build(1, { strength: 40 }), snapshot());
  closeTo(result.stats.get("health")?.value, 80);
  closeTo(result.stats.get("armor")?.value, 110);
});

test("the points arrive as their own context, so a breakdown can name them", () => {
  const result = calculate(build(10, { strength: 5, dexterity: 3 }), snapshot());
  const ctx = result.contexts.find((c) => c.type === "STAT_POINTS");
  assert.ok(ctx !== undefined, "no STAT_POINTS context");
  assert.equal(ctx.path, "character.statPoints");
  assert.deepEqual(
    ctx.stats.map((m) => [m.statId, m.type, m.value]).sort(),
    [
      ["dexterity", "FLAT", 3],
      ["strength", "FLAT", 5],
    ],
  );
});

test("a stat that is not a CoreStat grants nothing, and says so", () => {
  // `AllocateStatPacket` rejects it and an unregistered id resolves to `EmptyStat`, so in game
  // this does nothing at all. Doing nothing quietly would be the bug.
  const result = calculate(build(10, { armor: 50 }), snapshot());
  closeTo(result.stats.get("armor")?.value, 100);
  assert.ok(result.diagnostics.some((d) => d.code === "not-a-core-stat"));
});

test("no allocation means no context at all", () => {
  const result = calculate(build(10), snapshot());
  assert.equal(result.contexts.find((c) => c.type === "STAT_POINTS"), undefined);
});

test("zero points in a stat is not a contribution", () => {
  const result = calculate(build(10, { strength: 0 }), snapshot());
  assert.equal(result.contexts.find((c) => c.type === "STAT_POINTS"), undefined);
});
