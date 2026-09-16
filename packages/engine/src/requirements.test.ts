import assert from "node:assert/strict";
import { test } from "node:test";

import type { Item } from "@cte2/schema";

import { baseGear, engineSnapshot, statEntry } from "./test-support.js";
import { checkRequirements, gearRequirements } from "./requirements.js";

const SNAPSHOT = engineSnapshot({
  mmorpg_stat: {
    strength: statEntry("strength", { scaling: "CORE" }),
    dexterity: statEntry("dexterity", { scaling: "CORE" }),
  },
  mmorpg_base_gear_types: {
    // The pack's own axe: `scaling_req: { strength: 0.4 }`, and nothing in `base_req`.
    axe: { ...baseGear("axe", "axe", ["weapon_family", "axe"]), req: { base_req: {}, scaling_req: { strength: 0.4 } } },
    // Half and half, as every hybrid base in the pack declares it.
    sword: {
      ...baseGear("sword", "sword", ["weapon_family", "sword"]),
      req: { base_req: {}, scaling_req: { strength: 0.25, dexterity: 0.25 } },
    },
    // No `req` block at all — the shape a datapack that omits it produces.
    ring: baseGear("ring", "ring", ["jewelry_family"]),
    // `base_req` is empty across all 43 bases in this pack, so it is only reachable in a test.
    relic: { ...baseGear("relic", "necklace", ["jewelry_family"]), req: { base_req: { strength: 30 }, scaling_req: {} } },
  },
  mmorpg_gear_slot: {
    axe: { id: "axe", fam: "Weapon" },
    sword: { id: "sword", fam: "Weapon" },
    ring: { id: "ring", fam: "Jewelry" },
    necklace: { id: "necklace", fam: "Jewelry" },
  },
});

test("a scaling requirement is the declared fraction times 2 x the item's level", () => {
  // `STAT_REQ_SCALING` is `base 2 / per level 2`, so `getMultiFor(lvl)` is `2 + 2(lvl-1)` = 2*lvl.
  assert.deepEqual(gearRequirements(SNAPSHOT, "axe", 100), [
    { statId: "strength", required: 80, scaled: true },
  ]);
  assert.deepEqual(gearRequirements(SNAPSHOT, "axe", 40), [
    { statId: "strength", required: 32, scaled: true },
  ]);
});

test("the level is the item's, and a requirement that truncates to zero is not a requirement", () => {
  // 0.4 * 2 = 0.8, and `getScalingReq` casts to int. The game prints no line for it either:
  // `GetTooltipString` guards on `num > 0`.
  assert.deepEqual(gearRequirements(SNAPSHOT, "axe", 1), []);
});

test("a hybrid base asks for both halves", () => {
  const reqs = gearRequirements(SNAPSHOT, "sword", 100);
  assert.deepEqual(
    [...reqs].sort((a, b) => a.statId.localeCompare(b.statId)),
    [
      { statId: "dexterity", required: 50, scaled: true },
      { statId: "strength", required: 50, scaled: true },
    ],
  );
});

test("base_req does not scale with level and scaling_req does", () => {
  assert.deepEqual(gearRequirements(SNAPSHOT, "relic", 1), [
    { statId: "strength", required: 30, scaled: false },
  ]);
  assert.deepEqual(gearRequirements(SNAPSHOT, "relic", 100), [
    { statId: "strength", required: 30, scaled: false },
  ]);
});

test("statReqMulti multiplies both halves, and Lite mode's 0.1 all but removes them", () => {
  assert.deepEqual(gearRequirements(SNAPSHOT, "axe", 100, { statReqMulti: 0.1 }), [
    { statId: "strength", required: 8, scaled: true },
  ]);
});

test("a base with no req block demands nothing", () => {
  assert.deepEqual(gearRequirements(SNAPSHOT, "ring", 100), []);
});

test("an unknown base demands nothing rather than throwing", () => {
  assert.deepEqual(gearRequirements(SNAPSHOT, "not_a_base", 100), []);
});

test("a check compares against the finished sheet, and the boundary is inclusive", () => {
  const item: Item = { base: "axe", rarity: "rare", itemLevel: 100 };

  // `meetsReq` fails on `num > value`, so having exactly the requirement passes.
  const exactly = checkRequirements(SNAPSHOT, item, new Map([["strength", { value: 80 }]]));
  assert.deepEqual(exactly, [{ statId: "strength", required: 80, scaled: true, have: 80, met: true }]);

  const short = checkRequirements(SNAPSHOT, item, new Map([["strength", { value: 79.9 }]]));
  assert.equal(short[0]?.met, false);

  // A stat nothing contributed to is absent from the sparse container, not zero.
  const none = checkRequirements(SNAPSHOT, item, new Map());
  assert.deepEqual(none, [{ statId: "strength", required: 80, scaled: true, have: 0, met: false }]);
});
