/**
 * A jewel with no socket is a jewel on the floor.
 *
 * `JewelInvHelper.checkRemoveJewels` counts as it walks the inventory and `unequip`s everything
 * past `getJewelSocketsMaxStat`, which is `(int) getCalculatedStat(JewelSocketStat)`. So the
 * cap is not a constant: it is how many `jewel_socket` talents the tree allocation reaches, plus
 * whatever gear grants — Bubonic Trail's 1-2 and Hungering Vessel's 4 are the only two uniques
 * in this pack that do.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { BuildDoc, Jewel } from "@cte2/schema";

import { calculate } from "../calculate.js";
import { baseGear, closeTo, engineSnapshot, exact, rolled, statEntry } from "../test-support.js";

const SNAPSHOT = engineSnapshot({
  mmorpg_stat: {
    armor: statEntry("armor"),
    // `JewelSocketStat.max` is 9 and it does not scale.
    jewel_socket: statEntry("jewel_socket", { max: 9 }),
  },
  mmorpg_affixes: {
    jewel_armor: {
      guid: "jewel_armor",
      type: "jewel",
      stats: [rolled("armor", "FLAT", 10, 10)],
      requirements: { tag_requirements: [] },
    },
  },
  mmorpg_gear_rarity: {
    epic: { id: "epic", min_affixes: 3, stat_percents: { min: 52, max: 68 } },
    unique: { id: "unique", is_unique_item: true, min_affixes: 0, base_stat_percents: { min: 75, max: 100 }, stat_percents: { min: 0, max: 100 } },
  },
  mmorpg_base_gear_types: {
    chainmail_chest: baseGear("chainmail_chest", "chest", ["armor_family", "chest"]),
  },
  mmorpg_gear_slot: { chest: { id: "chest", fam: "Armor" } },
  mmorpg_unique_gears: {
    // Hungering Vessel, whose whole point is the four sockets.
    hungering_vessel: {
      id: "hungering_vessel",
      base_gear: "chainmail_chest",
      min_drop_lvl: 1,
      unique_stats: [rolled("jewel_socket", "FLAT", 4, 4)],
    },
  },
  mmorpg_perk: {
    jewel_socket: { id: "jewel_socket", type: "SPECIAL", max_lvls: 1, stats: [exact("jewel_socket", "FLAT", 1)] },
  },
  mmorpg_talent_tree: {
    talents: { identifier: "talents", perks: "jewel_socket,jewel_socket,jewel_socket" },
  },
});

const JEWEL: Jewel = {
  rarity: "epic",
  itemLevel: 100,
  affixes: [{ affixId: "jewel_armor", tier: "epic", rollPercent: 0 }],
};

function build(jewels: number, sockets: number, gear: BuildDoc["gear"] = []): BuildDoc {
  return {
    schemaVersion: 1,
    character: { level: 100 },
    tree: { talents: Array.from({ length: sockets }, (_, i): [number, number] => [0, i]) },
    gear,
    jewels: Array.from({ length: jewels }, () => JEWEL),
  };
}

test("jewels count only up to the allocated socket count", () => {
  // Two sockets, three jewels: 20 armour, not 30, and the third is named.
  const result = calculate(build(3, 2), SNAPSHOT);
  closeTo(result.stats.get("armor")?.value, 20);

  const unsocketed = result.diagnostics.filter((d) => d.code === "jewel-without-socket");
  assert.equal(unsocketed.length, 1);
  assert.equal(unsocketed[0]?.path, "jewels[2]");
});

test("no sockets means no jewels at all, however many the document lists", () => {
  const result = calculate(build(2, 0), SNAPSHOT);
  // The container is sparse, so nothing contributed reads as absent rather than 0.
  assert.equal(result.stats.get("armor"), undefined);
  assert.equal(result.diagnostics.filter((d) => d.code === "jewel-without-socket").length, 2);
});

test("a socketed jewel raises no diagnostic", () => {
  const result = calculate(build(3, 3), SNAPSHOT);
  closeTo(result.stats.get("armor")?.value, 30);
  assert.equal(result.diagnostics.some((d) => d.code === "jewel-without-socket"), false);
});

test("a unique that grants sockets counts as much as the tree does", () => {
  // Hungering Vessel's four, no tree allocation at all. Reading the budget off the perks alone
  // would have called every one of these unsocketed.
  const result = calculate(
    build(4, 0, [{ base: "chainmail_chest", rarity: "unique", itemLevel: 100, unique: "hungering_vessel", uniqueRolls: [0] }]),
    SNAPSHOT,
  );
  closeTo(result.stats.get("armor")?.value, 40);
  assert.equal(result.diagnostics.some((d) => d.code === "jewel-without-socket"), false);
});
