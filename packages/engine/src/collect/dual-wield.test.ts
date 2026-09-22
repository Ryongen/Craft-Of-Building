import assert from "node:assert/strict";
import { test } from "node:test";

import type { BuildDoc, Item } from "@cte2/schema";

import { calculate } from "../calculate.js";
import { baseGear, closeTo, engineSnapshot, rolled, statEntry } from "../test-support.js";

/**
 * A one-handed weapon in the offhand — `GearData.calcStatUtilization` and `isUsableBy`, checked
 * against the 6.4.13 jar.
 */
const SNAPSHOT = engineSnapshot({
  mmorpg_stat: {
    weapon_damage: statEntry("weapon_damage"),
    dual_wield_effectiveness: statEntry("dual_wield_effectiveness"),
  },
  mmorpg_base_gear_types: {
    sword: {
      ...baseGear("sword", "sword", ["weapon_family", "sword"], [rolled("weapon_damage", "FLAT", 100, 100)]),
      weapon_type: "sword",
    },
    bow: {
      ...baseGear("bow", "bow", ["weapon_family", "bow"], [rolled("weapon_damage", "FLAT", 1000, 1000)]),
      weapon_type: "bow",
    },
    necklace: baseGear("necklace", "necklace", ["jewelry_family"], [
      rolled("dual_wield_effectiveness", "FLAT", 20, 20),
    ]),
  },
  mmorpg_gear_slot: {
    sword: { id: "sword", fam: "Weapon" },
    bow: { id: "bow", fam: "Weapon" },
    necklace: { id: "necklace", fam: "Jewelry" },
  },
  mmorpg_weapon_type: {
    sword: { id: "sword", can_dual_wield: true },
    bow: { id: "bow", can_dual_wield: false },
  },
  mmorpg_gear_rarity: {
    common: { id: "common", min_affixes: 0, base_stat_percents: { min: 0, max: 100 }, stat_percents: { min: 0, max: 100 } },
  },
});

const piece = (base: string, extra: Partial<Item> = {}): Item => ({
  base,
  rarity: "common",
  itemLevel: 1,
  baseRolls: [100],
  ...extra,
});

function withGear(gear: Item[]): BuildDoc {
  return { schemaVersion: 1, character: { level: 1 }, gear };
}

const weaponDamage = (gear: Item[]): number | undefined =>
  calculate(withGear(gear), SNAPSHOT).stats.get("weapon_damage")?.value;

test("an offhand sword grants PERC_OFFHAND_WEP_STAT (25%) of its stats", () => {
  closeTo(weaponDamage([piece("sword"), piece("sword", { offhand: true })]), 125);
});

test("an empty mainhand does not block the offhand weapon", () => {
  closeTo(weaponDamage([piece("sword", { offhand: true })]), 25);
});

test("Dual-Wield Effectiveness multiplies the share rather than adding to it", () => {
  // 25% * (1 + 20/100) = 30%, not 45%.
  closeTo(
    weaponDamage([piece("sword"), piece("sword", { offhand: true }), piece("necklace")]),
    130,
  );
});

test("a mainhand that cannot be dual wielded blocks the offhand weapon entirely", () => {
  closeTo(weaponDamage([piece("bow"), piece("sword", { offhand: true })]), 1000);
});

test("a weapon that cannot be dual wielded grants nothing from the offhand", () => {
  closeTo(weaponDamage([piece("sword"), piece("bow", { offhand: true })]), 100);
});

test("without the flag, the second sword is a second mainhand and counts in full", () => {
  // Not a legal loadout — the validator says so — but the engine sums what it is given.
  assert.equal(weaponDamage([piece("sword"), piece("sword")]), 200);
});

test("a mirrored sword is the same item in both hands, not a copy", () => {
  closeTo(weaponDamage([piece("sword", { mirrored: true })]), 125);
});

test("a mirrored ring is two rings to the stat sheet", () => {
  const snapshot = engineSnapshot({
    mmorpg_stat: { weapon_damage: statEntry("weapon_damage") },
    mmorpg_base_gear_types: {
      ring: baseGear("ring", "ring", ["jewelry_family"], [rolled("weapon_damage", "FLAT", 10, 10)]),
    },
    mmorpg_gear_slot: { ring: { id: "ring", fam: "Jewelry" } },
    mmorpg_gear_rarity: {
      common: { id: "common", min_affixes: 0, base_stat_percents: { min: 0, max: 100 }, stat_percents: { min: 0, max: 100 } },
    },
  });
  const value = calculate(withGear([piece("ring", { mirrored: true })]), snapshot).stats.get("weapon_damage")?.value;
  closeTo(value, 20);
});

test("a mirror on a weapon that cannot be dual wielded is ignored", () => {
  closeTo(weaponDamage([piece("bow", { mirrored: true })]), 1000);
});
