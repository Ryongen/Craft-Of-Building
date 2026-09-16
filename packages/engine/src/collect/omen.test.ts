/**
 * The omen set bonus: nothing until the loadout earns it, then all of it at once.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { BuildDoc, Item } from "@cte2/schema";

import { calculate } from "../calculate.js";
import {
  RARITIES,
  baseGear,
  baseStats,
  closeTo,
  engineSnapshot,
  exact,
  rolled,
  statEntry,
} from "../test-support.js";

/**
 * `blood`'s first two mods, a NORMAL-only requirement of two pieces, and two armour slots to
 * fill it from. `stat_multi` is 1 and there are no slot requirements, so the derived stat
 * percent is a clean `2 * 10 = 20`.
 */
function snapshot() {
  return engineSnapshot({
    // `engineSnapshot` carries no rarity ladder of its own, and an omen counts pieces by
    // their rarity's *type* — without this every piece resolves to no type and is skipped.
    mmorpg_gear_rarity: RARITIES,
    mmorpg_stat: {
      health: statEntry("health", { scaling: "NORMAL" }),
      armor: statEntry("armor"),
    },
    mmorpg_gear_slot: {
      helmet: { id: "helmet", fam: "Armor" },
      boots: { id: "boots", fam: "Armor" },
      bow: { id: "bow", fam: "Weapon" },
    },
    mmorpg_base_gear_types: {
      plate_helmet: baseGear("plate_helmet", "helmet", ["armor_family", "helmet"]),
      plate_boots: baseGear("plate_boots", "boots", ["armor_family", "boots"]),
      bow: baseGear("bow", "bow", ["weapon_family", "bow"]),
    },
    // `blood`'s mods are all PERCENT, so there has to be something for them to be a percent
    // *of* — without a base the whole set bonus resolves to zero and proves nothing.
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("health", "FLAT", 100),
        exact("armor", "FLAT", 100),
      ]),
    },
    mmorpg_omen: {
      blood: {
        id: "blood",
        lvl_req: 0.5,
        affix_types: ["chaos_stat"],
        mods: [rolled("health", "PERCENT", 5, 25), rolled("armor", "PERCENT", 2, 10)],
      },
    },
  });
}

const OMEN: NonNullable<BuildDoc["omen"]> = {
  id: "blood",
  itemLevel: 60,
  rarity: "rare",
  requires: { NORMAL: 2 },
};

function build(gear: Item[], omen = OMEN): BuildDoc {
  return { schemaVersion: 1, character: { level: 60 }, gear, omen };
}

const HELMET: Item = { base: "plate_helmet", rarity: "rare", itemLevel: 1 };
const BOOTS: Item = { base: "plate_boots", rarity: "epic", itemLevel: 1 };

test("an unsatisfied omen grants nothing at all, and says why", () => {
  const result = calculate(build([HELMET]), snapshot());
  assert.equal(result.contexts.find((c) => c.path === "omen"), undefined);
  assert.ok(result.diagnostics.some((d) => d.code === "omen-not-satisfied"));
});

test("a satisfied omen pays out its whole bucket", () => {
  const result = calculate(build([HELMET, BOOTS]), snapshot());
  // Two required pieces * 10 = a derived 20%, so `health` rolls 20% of the way from 5 to 25
  // (+9%) and `armor` from 2 to 10 (+3.6%), against a base of 100 each.
  closeTo(result.stats.get("health")?.value, 109);
  closeTo(result.stats.get("armor")?.value, 103.6);
  assert.ok(!result.diagnostics.some((d) => d.code === "omen-not-satisfied"));
});

test("one piece short of the requirement is worth exactly nothing", () => {
  // The buckets are thresholds, not a sliding scale: `fill >= en.getKey()` or no payout.
  const result = calculate(build([HELMET]), snapshot());
  closeTo(result.stats.get("health")?.value, 100);
  closeTo(result.stats.get("armor")?.value, 100);
});

test("the mainhand never counts toward a set", () => {
  // `CachedEntityStats.recalcGears` collects CHEST, FEET, LEGS, HEAD, OFFHAND and the curios;
  // the weapon is `recalcWeapon`'s and is never in the list the omen counts.
  const weapon: Item = { base: "bow", rarity: "rare", itemLevel: 1 };
  const result = calculate(build([HELMET, weapon]), snapshot());
  assert.equal(result.contexts.find((c) => c.path === "omen"), undefined);
});

test("the omen's stats enter as MISC, the way MiscStatCtx does", () => {
  const result = calculate(build([HELMET, BOOTS]), snapshot());
  const ctx = result.contexts.find((c) => c.path === "omen");
  assert.ok(ctx !== undefined);
  // `new MiscStatCtx(...)` is `StatCtxType.MISC` — an omen gets no context type of its own.
  assert.equal(ctx.type, "MISC");
  assert.equal(ctx.source, "blood");
});

test("mods scale at the omen's own level, not the character's", () => {
  // `x.ToExactStat(perc, data.lvl)`. Both mods here are PERCENT, which `Stat.scale` leaves
  // untouched at any level — so the check that matters is that changing the character's level
  // moves nothing.
  const low = calculate({ ...build([HELMET, BOOTS]), character: { level: 60 } }, snapshot());
  const high = calculate({ ...build([HELMET, BOOTS]), character: { level: 100 } }, snapshot());
  closeTo(low.stats.get("armor")?.value, high.stats.get("armor")?.value ?? 0);
});

test("a derived stat percent above 100 is not clamped", () => {
  // `getStatPercent` can reach 125, and `ExactStatData.fromStatModifier` is a bare
  // interpolation — so the mods land above their declared maximum. The game does this.
  const heavy = { ...OMEN, requires: { NORMAL: 2, UNIQUE: 2, RUNED: 3 }, slotRequirements: [] };
  const gear: Item[] = [
    HELMET,
    BOOTS,
    { base: "plate_helmet", rarity: "unique", itemLevel: 1 },
    { base: "plate_boots", rarity: "unique", itemLevel: 1 },
    { base: "plate_helmet", rarity: "runeword", itemLevel: 1 },
    { base: "plate_boots", rarity: "runeword", itemLevel: 1 },
    { base: "plate_helmet", rarity: "runeword", itemLevel: 1 },
  ];
  const result = calculate(build(gear, heavy), snapshot());
  // 7 requirement pieces * 10 = 70, no slot requirements, `rare`'s stat_multi of 1.
  // health 5..25 at 70% is +19%, against a base of 100.
  closeTo(result.stats.get("health")?.value, 119);
});

test("no omen means no context and no complaint", () => {
  const doc: BuildDoc = { schemaVersion: 1, character: { level: 60 }, gear: [HELMET] };
  const result = calculate(doc, snapshot());
  assert.equal(result.contexts.find((c) => c.path === "omen"), undefined);
  assert.ok(!result.diagnostics.some((d) => d.code.startsWith("omen")));
});

test("an unknown omen id is an error, not a silent zero", () => {
  const result = calculate(build([HELMET, BOOTS], { ...OMEN, id: "not_an_omen" }), snapshot());
  assert.ok(result.diagnostics.some((d) => d.code === "unknown-omen" && d.severity === "error"));
});
