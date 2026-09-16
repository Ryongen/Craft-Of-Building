/**
 * `mmorpg_sets` — the four rules a gear set has, each pinned on its own.
 *
 * Every one is a line of `StatCalculation.addItemSetStats` / `EquippedSets.Counter`, and three of
 * the four are the kind that produce a plausible number when they are wrong: a set that counted
 * duplicates would pay out for one ring worn twice, a set that took the highest tier instead of
 * all of them would quietly drop the 2-piece bonus off a 4-piece set, and one that scaled to the
 * character's level instead of the pieces' would be right on exactly the builds where the two
 * happen to match.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BuildDoc } from "@cte2/schema";

import { calculate } from "../calculate.js";
import { baseStats, engineSnapshot, statEntry } from "../test-support.js";

/** Two sets: a two-piece with one tier, and a three-piece with two cumulative tiers. */
function snapshot() {
  return engineSnapshot({
    mmorpg_stat: {
      armor: statEntry("armor"),
      magic_find: statEntry("magic_find"),
      // NORMAL scaling, so a FLAT mod on it moves with the level it is rolled at —
      // which is what makes the average-item-level rule measurable at all.
      health: statEntry("health", { scaling: "NORMAL" }),
    },
    mmorpg_base_stats: { original_mode_player: baseStats("original_mode_player", []) },
    mmorpg_base_gear_types: {
      ring: { guid: "ring", gear_slot: "ring", weapon_type: "none", base_stats: [] },
      boots: { guid: "boots", gear_slot: "boots", weapon_type: "none", base_stats: [] },
    },
    mmorpg_unique_gears: {
      ring_a: { guid: "ring_a", base_gear: "ring", rarity: "unique", unique_stats: [] },
      ring_b: { guid: "ring_b", base_gear: "ring", rarity: "unique", unique_stats: [] },
      ring_c: { guid: "ring_c", base_gear: "ring", rarity: "unique", unique_stats: [] },
      ring_d: { guid: "ring_d", base_gear: "ring", rarity: "unique", unique_stats: [] },
      boots_a: { guid: "boots_a", base_gear: "boots", rarity: "unique", unique_stats: [] },
      loner: { guid: "loner", base_gear: "ring", rarity: "unique", unique_stats: [] },
    },
    mmorpg_sets: {
      pair: {
        id: "pair",
        uniques: ["ring_a", "ring_b"],
        bonuses: [
          {
            pieces: 2,
            stats: [
              { type: "FLAT", min: 25, max: 25, stat: "magic_find" },
              { type: "FLAT", min: 5, max: 5, stat: "health" },
            ],
          },
        ],
      },
      trio: {
        id: "trio",
        uniques: ["ring_c", "ring_d", "boots_a"],
        bonuses: [
          { pieces: 3, stats: [{ type: "FLAT", min: 7, max: 7, stat: "magic_find" }] },
          { pieces: 2, stats: [{ type: "FLAT", min: 3, max: 3, stat: "magic_find" }] },
        ],
      },
      // `ItemSets.EMPTY`, the registry's own default entry. It must contribute nothing.
      empty: { id: "empty", uniques: [], bonuses: [] },
    },
  });
}

function build(pieces: { unique: string; itemLevel?: number }[]): BuildDoc {
  return {
    schemaVersion: 1,
    character: { level: 100 },
    gear: pieces.map((p) => ({
      base: p.unique.startsWith("boots") ? "boots" : "ring",
      rarity: "unique",
      itemLevel: p.itemLevel ?? 100,
      unique: p.unique,
    })),
  } as BuildDoc;
}

/** The ITEM_SET contexts a build produces, as `{ setId: [stat, value] }`. */
function setContexts(doc: BuildDoc) {
  return calculate(doc, snapshot())
    .contexts.filter((c) => c.type === "ITEM_SET")
    .map((c) => [c.source, c.stats.map((m) => [m.statId, m.value] as const)] as const);
}

test("a set pays nothing until its piece count reaches a tier", () => {
  assert.deepEqual(setContexts(build([{ unique: "ring_a" }])), []);

  const two = setContexts(build([{ unique: "ring_a" }, { unique: "ring_b" }]));
  assert.deepEqual(
    two.map(([id, stats]) => [id, stats.map(([stat]) => stat)]),
    [["pair", ["magic_find", "health"]]],
  );
  assert.equal(two[0]?.[1][0]?.[1], 25);

  // `trio`'s lower tier, with one of its three on.
  const lower = setContexts(build([{ unique: "ring_c" }, { unique: "ring_d" }]));
  assert.deepEqual(lower, [["trio", [["magic_find", 3]]]]);
});

test("pieces are deduped by unique id, so one item worn twice completes nothing", () => {
  // `Counter.add` is `putIfAbsent(uniqueId, lvl)` into a map keyed by the unique. Without it a
  // ring in both ring slots would be a two-piece set on its own.
  assert.deepEqual(setContexts(build([{ unique: "ring_a" }, { unique: "ring_a" }])), []);
});

test("tiers are cumulative: a full set grants every tier at or below its count", () => {
  // `isActive` is `pieces >= bonus.pieces` and *every* bonus is tested, so three pieces of `trio`
  // pay both its 2-piece and its 3-piece tier. Declared out of order on purpose — the game sorts
  // by `pieces` before it walks them.
  const full = setContexts(build([{ unique: "ring_c" }, { unique: "ring_d" }, { unique: "boots_a" }]));
  const trio = full.find(([id]) => id === "trio");
  assert.deepEqual(trio?.[1], [
    ["magic_find", 3],
    ["magic_find", 7],
  ]);
});

test("a stat scales to the average item level of the pieces, not to the character", () => {
  // `bonus.getStats(equipped.avgLevel)`. The character is level 100 in every case below, so a
  // figure that moves with the pieces can only have come from their own levels.
  const at = (a: number, b: number) =>
    setContexts(build([{ unique: "ring_a", itemLevel: a }, { unique: "ring_b", itemLevel: b }]))
      .find(([id]) => id === "pair")?.[1]
      .find(([stat]) => stat === "health")?.[1];

  const high = at(100, 100);
  const low = at(1, 1);
  assert.ok(high !== undefined && low !== undefined);
  assert.ok(high > low, `level 100 pieces should out-scale level 1 ones, got ${high} vs ${low}`);

  // `total / pieces.size()` on ints, so (100 + 51) / 2 is 75 and not 75.5 — the mixed pair is
  // worth exactly what a matched pair of level 75 pieces is.
  assert.equal(at(100, 51), at(75, 75));
  assert.notEqual(at(100, 51), at(76, 76));
});

test("a set with no members, and a unique in no set, contribute nothing", () => {
  assert.deepEqual(setContexts(build([{ unique: "loner" }, { unique: "loner" }])), []);
});

test("a unique listed in two sets belongs to the last one, as `map.put` leaves it", () => {
  // `ItemSet.ofUnique` builds `unique -> set` with a plain `map.put`, so an overlap is an
  // overwrite rather than double membership. No unique in this pack is in two sets, but a pack
  // that changed that should pay once, for the later set, rather than twice.
  const overlapping = engineSnapshot({
    mmorpg_stat: { magic_find: statEntry("magic_find") },
    mmorpg_base_stats: { original_mode_player: baseStats("original_mode_player", []) },
    mmorpg_base_gear_types: { ring: { guid: "ring", gear_slot: "ring", weapon_type: "none", base_stats: [] } },
    mmorpg_unique_gears: {
      ring_a: { guid: "ring_a", base_gear: "ring", rarity: "unique", unique_stats: [] },
      ring_b: { guid: "ring_b", base_gear: "ring", rarity: "unique", unique_stats: [] },
    },
    mmorpg_sets: {
      first: { id: "first", uniques: ["ring_a", "ring_b"], bonuses: [{ pieces: 2, stats: [{ type: "FLAT", min: 1, max: 1, stat: "magic_find" }] }] },
      second: { id: "second", uniques: ["ring_a", "ring_b"], bonuses: [{ pieces: 2, stats: [{ type: "FLAT", min: 2, max: 2, stat: "magic_find" }] }] },
    },
  });
  const doc = build([{ unique: "ring_a" }, { unique: "ring_b" }]);
  const found = calculate(doc, overlapping)
    .contexts.filter((c) => c.type === "ITEM_SET")
    .map((c) => c.source);
  assert.deepEqual(found, ["second"]);
});
