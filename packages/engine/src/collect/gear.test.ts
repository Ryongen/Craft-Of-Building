import assert from "node:assert/strict";
import { test } from "node:test";

import type { AuraSetup, BuildDoc, Item, Jewel } from "@cte2/schema";

import { calculate } from "../calculate.js";
import {
  baseGear,
  closeTo,
  engineSnapshot,
  exact,
  rolled,
  statEntry,
} from "../test-support.js";

const SNAPSHOT = engineSnapshot({
  mmorpg_stat: {
    armor: statEntry("armor", { scaling: "NORMAL" }),
    weapon_damage: statEntry("weapon_damage"),
    mana: statEntry("mana"),
    intelligence: statEntry("intelligence"),
    increase_healing: statEntry("increase_healing"),
  },
  mmorpg_base_gear_types: {
    boots: baseGear("boots", "boots", ["armor_family", "boots"], [rolled("armor", "FLAT", 4, 8)]),
    bow: baseGear("bow", "bow", ["weapon_family", "bow"], [rolled("weapon_damage", "FLAT", 6, 12)]),
    necklace: baseGear("necklace", "necklace", ["jewelry_family"]),
  },
  mmorpg_gear_slot: {
    boots: { id: "boots", fam: "Armor" },
    bow: { id: "bow", fam: "Weapon" },
    necklace: { id: "necklace", fam: "Jewelry" },
  },
  mmorpg_affixes: {
    of_the_bear: {
      guid: "of_the_bear",
      type: "suffix",
      stats: [rolled("armor", "FLAT", 10, 20)],
      requirements: { tag_requirements: [] },
    },
  },
  mmorpg_gems: {
    amethyst0: {
      identifier: "amethyst0",
      on_armor_stats: [exact("mana", "PERCENT", 6)],
      on_jewelry_stats: [exact("intelligence", "PERCENT", 3)],
      on_weapons_stats: [exact("increase_healing", "FLAT", 9)],
    },
  },
  mmorpg_runes: {
    ano: { id: "ano", on_armor_stats: [rolled("armor", "PERCENT", 6, 10)] },
  },
  mmorpg_gear_rarity: {
    // The bands Craft to Exile 2 actually ships: a common can roll a base stat anywhere in
    // 0..100, a unique only in 75..100.
    common: { id: "common", min_affixes: 1, base_stat_percents: { min: 0, max: 100 }, stat_percents: { min: 0, max: 17 } },
    unique: {
      id: "unique",
      is_unique_item: true,
      min_affixes: 0,
      base_stat_percents: { min: 75, max: 100 },
      stat_percents: { min: 0, max: 100 },
    },
  },
  mmorpg_unique_gears: {
    warded_step: {
      guid: "warded_step",
      base_gear: "boots",
      rarity: "unique",
      unique_stats: [rolled("gear_defense", "PERCENT", 20, 20)],
    },
  },
});

function withGear(gear: Item[], level = 1): BuildDoc {
  return { schemaVersion: 1, character: { level }, gear };
}

test("an item's stats roll between the base's min and max at the given percent", () => {
  const result = calculate(withGear([{ base: "boots", rarity: "common", itemLevel: 1, baseRolls: [50] }]), SNAPSHOT);
  closeTo(result.stats.get("armor")?.value, 6);
});

test("gear scales at the item's level, not the character's", () => {
  // `SocketData.GetAllStats` and the affix path both pass `gear.lvl`; a level 40 character in
  // level 1 boots gets level 1 boots.
  const result = calculate(
    withGear([{ base: "boots", rarity: "common", itemLevel: 1, baseRolls: [100] }], 40),
    SNAPSHOT,
  );
  closeTo(result.stats.get("armor")?.value, 8);
});

test("an item above the character's level contributes nothing at all", () => {
  // `if (gear.lvl > data.getLevel()) { return false; }` — GearData.isUsableBy,
  // GearData.java:113-119. Not a reduced amount: nothing.
  const result = calculate(
    withGear([{ base: "boots", rarity: "common", itemLevel: 30, baseRolls: [100] }], 20),
    SNAPSHOT,
  );

  assert.equal(result.stats.get("armor"), undefined);
  assert.ok(result.diagnostics.some((d) => d.code === "item-above-character-level"));
});

test("affix rolls stack with the base's own stats", () => {
  const result = calculate(
    withGear([
      {
        base: "boots",
        rarity: "common",
        itemLevel: 1,
        baseRolls: [0],
        suffixes: [{ affixId: "of_the_bear", tier: "common", rollPercent: 50 }],
      },
    ]),
    SNAPSHOT,
  );

  // 4 from the base at 0%, 15 from the affix at 50%.
  closeTo(result.stats.get("armor")?.value, 19);
});

test("a missing baseRolls is reported rather than guessed", () => {
  const result = calculate(withGear([{ base: "boots", rarity: "common", itemLevel: 1 }]), SNAPSHOT);

  assert.ok(result.diagnostics.some((d) => d.code === "missing-base-rolls"));
  // The minimum, so the number is a floor rather than an invention.
  closeTo(result.stats.get("armor")?.value, 4);
});

test("a gem grants the stat list matching the slot's family", () => {
  // `if (sfor == SlotFamily.Armor) { return on_armor_stats; }` ... — BaseGem.java:33-46.
  const armor = calculate(
    withGear([{ base: "boots", rarity: "common", itemLevel: 1, baseRolls: [0], sockets: ["amethyst0"] }]),
    SNAPSHOT,
  );
  assert.ok(armor.stats.has("mana"));
  assert.ok(!armor.stats.has("intelligence"));

  const jewelry = calculate(
    withGear([{ base: "necklace", rarity: "common", itemLevel: 1, sockets: ["amethyst0"] }]),
    SNAPSHOT,
  );
  assert.ok(jewelry.stats.has("intelligence"));
  assert.ok(!jewelry.stats.has("mana"));

  const weapon = calculate(
    withGear([{ base: "bow", rarity: "common", itemLevel: 1, baseRolls: [0], sockets: ["amethyst0"] }]),
    SNAPSHOT,
  );
  assert.ok(weapon.stats.has("increase_healing"));
});

test("a rune's roll is not in the build document, so it is computed at 0% and said so", () => {
  // The roll lives on the socket (`SocketData.p`), which the document has no field for.
  const result = calculate(
    withGear([{ base: "boots", rarity: "common", itemLevel: 1, baseRolls: [100], runes: ["ano"] }]),
    SNAPSHOT,
  );

  assert.ok(result.diagnostics.some((d) => d.code === "rune-roll-unknown"));
  // 8 armor from the base, +6% from the rune at its minimum.
  closeTo(result.stats.get("armor")?.value, 8.48);
});

test("an unknown base is an error, not a silent zero", () => {
  const result = calculate(withGear([{ base: "nonexistent", rarity: "common", itemLevel: 1 }]), SNAPSHOT);
  assert.ok(result.diagnostics.some((d) => d.severity === "error" && d.code === "unknown-base"));
});

test("gear_defense multiplies the item's own base defense instead of standing alone", () => {
  // `gear_defense` is an `IBaseStatModifier`: `BaseStatsData.GetAllStats` reads it off the
  // item's other containers and rewrites the base stat with it. Leaving it as a loose stat
  // understated every defensive unique — in game Honourhome's +14% is already inside the
  // "+135 Armor" line, not a separate one.
  const result = calculate(
    withGear([
      {
        base: "boots",
        rarity: "unique",
        itemLevel: 1,
        unique: "warded_step",
        baseRolls: [100],
        uniqueRolls: [0],
      },
    ]),
    SNAPSHOT,
  );

  // 8 armor at a full base roll, +20% gear_defense = 9.6.
  closeTo(result.stats.get("armor")?.value, 9.6);
});

test("a missing base roll falls back to the rarity's floor, not to zero", () => {
  // `BaseStatsData.getMinMax` bounds the roll by `base_stat_percents`, so 0 is not a
  // conservative guess for a unique — it is a value the game cannot produce.
  const result = calculate(
    withGear([{ base: "boots", rarity: "unique", itemLevel: 1, unique: "warded_step", uniqueRolls: [0] }]),
    SNAPSHOT,
  );

  assert.ok(result.diagnostics.some((d) => d.code === "missing-base-rolls"));
  // 4..8 armor at the 75% floor is 7, then +20% gear_defense.
  closeTo(result.stats.get("armor")?.value, 8.4);
});

test("a common item's floor is still zero, because that is its band", () => {
  const result = calculate(withGear([{ base: "boots", rarity: "common", itemLevel: 1 }]), SNAPSHOT);
  closeTo(result.stats.get("armor")?.value, 4);
});

test("gear_defense on one item does not reach another item's base stats", () => {
  // The modifier pass runs per item (`gear.GetAllStatContainersExceptBase()`), so a helmet's
  // gear_defense cannot inflate the boots.
  const result = calculate(
    withGear([
      { base: "boots", rarity: "common", itemLevel: 1, baseRolls: [100] },
      {
        base: "bow",
        rarity: "unique",
        itemLevel: 1,
        unique: "warded_step",
        baseRolls: [0],
        uniqueRolls: [0],
      },
    ]),
    SNAPSHOT,
  );

  closeTo(result.stats.get("armor")?.value, 8);
});

test("a runeword's stats roll at GearSocketsData.rp, not at its minimum", () => {
  // The capture records this as `runewordRoll`, and the engine used to ignore it and compute
  // every runeword at 0%. On a fully socketed item that is a large, silent shortfall.
  const snapshot = engineSnapshot({
    mmorpg_stat: { armor: statEntry("armor") },
    mmorpg_base_gear_types: { boots: baseGear("boots", "boots", ["armor_family", "boots"]) },
    mmorpg_gear_slot: { boots: { id: "boots", fam: "Armor" } },
    mmorpg_gear_rarity: {
      common: { id: "common", min_affixes: 0, base_stat_percents: { min: 0, max: 100 }, stat_percents: { min: 0, max: 17 }, can_have_runewords: true },
    },
    mmorpg_runeword: { wealth: { id: "wealth", stats: [rolled("armor", "FLAT", 0, 100)] } },
  });

  const item: Item = { base: "boots", rarity: "common", itemLevel: 1, runeword: "wealth" };
  const withRoll = calculate(withGear([{ ...item, runewordRoll: 38 }]), snapshot);
  closeTo(withRoll.stats.get("armor")?.value, 38);
  assert.ok(!withRoll.diagnostics.some((d) => d.code === "runeword-roll-unknown"));

  // Absent, it still computes at 0% — but says so rather than looking like a real number.
  const bare = calculate(withGear([item]), snapshot);
  closeTo(bare.stats.get("armor")?.value, 0);
  assert.ok(bare.diagnostics.some((d) => d.code === "runeword-roll-unknown"));
});

test("each rune rolls at its own SocketData.p, matched positionally", () => {
  const snapshot = engineSnapshot({
    mmorpg_stat: { armor: statEntry("armor") },
    mmorpg_base_gear_types: { boots: baseGear("boots", "boots", ["armor_family", "boots"]) },
    mmorpg_gear_slot: { boots: { id: "boots", fam: "Armor" } },
    mmorpg_gear_rarity: {
      common: { id: "common", min_affixes: 0, base_stat_percents: { min: 0, max: 100 }, stat_percents: { min: 0, max: 17 } },
    },
    mmorpg_runes: {
      oru: { id: "oru", on_armor_stats: [rolled("armor", "FLAT", 0, 100)] },
      toq: { id: "toq", on_armor_stats: [rolled("armor", "FLAT", 0, 100)] },
    },
  });

  // 25 from the first rune and 75 from the second, summed — not both at the minimum.
  const result = calculate(
    withGear([{ base: "boots", rarity: "common", itemLevel: 1, runes: ["oru", "toq"], runeRolls: [25, 75] }]),
    snapshot,
  );
  closeTo(result.stats.get("armor")?.value, 100);
  assert.ok(!result.diagnostics.some((d) => d.code === "rune-roll-unknown"));

  const bare = calculate(
    withGear([{ base: "boots", rarity: "common", itemLevel: 1, runes: ["oru", "toq"] }]),
    snapshot,
  );
  closeTo(bare.stats.get("armor")?.value, 0);
  assert.ok(bare.diagnostics.some((d) => d.code === "rune-roll-unknown"));
});

// ---------------------------------------------------------------------------
// Jewels
// ---------------------------------------------------------------------------

const JEWEL_SNAPSHOT = engineSnapshot({
  mmorpg_stat: {
    armor: statEntry("armor"),
    mana: statEntry("mana"),
    spirit_cost: statEntry("spirit_cost"),
  },
  mmorpg_aura: {
    chaos_res: { id: "chaos_res", stats: [rolled("mana", "FLAT", 10, 10)] },
  },
  mmorpg_affixes: {
    jewel_armor: {
      guid: "jewel_armor",
      type: "jewel",
      stats: [rolled("armor", "FLAT", 10, 20)],
      requirements: { tag_requirements: [] },
    },
    // `jewel_corruption` affixes live in `JewelItemData.cor`, a list of their own.
    jewel_corrupt_spirit_cost: {
      guid: "jewel_corrupt_spirit_cost",
      type: "jewel_corruption",
      stats: [rolled("spirit_cost", "FLAT", 2, 10)],
      requirements: { tag_requirements: [] },
    },
    // A Watcher's Eye line: live only while the aura named by `eye_aura_req` is socketed.
    chaos_res_eye: {
      guid: "chaos_res_eye",
      type: "watcher_eye",
      eye_aura_req: "chaos_res",
      stats: [rolled("armor", "FLAT", 3, 6)],
      requirements: { tag_requirements: [] },
    },
  },
  mmorpg_gear_rarity: {
    epic: { id: "epic", min_affixes: 3, stat_percents: { min: 52, max: 68 } },
  },
  // A jewel needs a socket before any of it counts, so the test tree carries three of the
  // `jewel_socket` talent and `withJewels` allocates all three.
  mmorpg_perk: {
    jewel_socket: {
      id: "jewel_socket",
      type: "SPECIAL",
      max_lvls: 1,
      stats: [exact("jewel_socket", "FLAT", 1)],
    },
  },
  mmorpg_talent_tree: {
    talents: { identifier: "talents", perks: "jewel_socket,jewel_socket,jewel_socket" },
  },
});

/**
 * Three sockets are allocated whatever the jewel count, because these tests are about what a
 * socketed jewel contributes rather than about the socket rule — which
 * `jewel-without-socket.test.ts` covers on its own.
 */
function withJewels(jewels: Jewel[], auras: AuraSetup[] = []): BuildDoc {
  return {
    schemaVersion: 1,
    character: { level: 100 },
    tree: { talents: [[0, 0], [0, 1], [0, 2]] },
    jewels,
    auras,
  };
}

test("a jewel's corruptions count, alongside its rolled affixes", () => {
  // `JewelItemData.getStatAndContext` walks `affixes` and then `cor` into the same JEWEL
  // context. Reading only the first list left a corrupted jewel contributing as if it were
  // uncorrupted, which is where `spirit_cost` and the immunity lines live.
  const result = calculate(
    withJewels([
      {
        rarity: "epic",
        itemLevel: 100,
        affixes: [{ affixId: "jewel_armor", tier: "epic", rollPercent: 50 }],
        corruptions: [{ affixId: "jewel_corrupt_spirit_cost", tier: "epic", rollPercent: 84 }],
      },
    ]),
    JEWEL_SNAPSHOT,
  );
  closeTo(result.stats.get("armor")?.value, 15);
  closeTo(result.stats.get("spirit_cost")?.value, 2 + 8 * 0.84);
});

test("a Watcher's Eye line counts only while its aura is socketed", () => {
  const eye: Jewel[] = [
    {
      rarity: "epic",
      itemLevel: 100,
      auraStats: [{ affixId: "chaos_res_eye", rollPercent: 65, itemLevel: 100 }],
    },
  ];

  // `if (data.aurasOn.contains(aura.getAura().id))` — and `getAura()` reads `eye_aura_req` off
  // the affix, not off the jewel record.
  const running = calculate(withJewels(eye, [{ id: "chaos_res", rollPercent: 100 }]), JEWEL_SNAPSHOT);
  closeTo(running.stats.get("armor")?.value, 3 + 3 * 0.65);

  // The container is sparse, so a stat nothing contributed to is absent rather than zero —
  // which is the game's own behaviour (`getCalculatedStat` defaults to `new StatData(guid, 0, 1)`).
  const notRunning = calculate(withJewels(eye), JEWEL_SNAPSHOT);
  assert.equal(notRunning.stats.get("armor"), undefined);

  // An aura the planner has unticked is not socketed either.
  const unticked = calculate(
    withJewels(eye, [{ id: "chaos_res", rollPercent: 100, enabled: false }]),
    JEWEL_SNAPSHOT,
  );
  assert.equal(unticked.stats.get("armor"), undefined);
});

test("a Watcher's Eye line scales to the jewel's own level, not the character's", () => {
  // `StatsWhileUnderAuraData` carries its own `lvl` for exactly this reason.
  const result = calculate(
    withJewels(
      [
        {
          rarity: "epic",
          itemLevel: 100,
          auraStats: [{ affixId: "chaos_res_eye", rollPercent: 100, itemLevel: 1 }],
        },
      ],
      [{ id: "chaos_res", rollPercent: 100 }],
    ),
    JEWEL_SNAPSHOT,
  );
  // `armor` has NONE scaling here, so the level cannot change the number — what this pins is
  // that the record's own `itemLevel` is the one that reaches `rollToExact` at all.
  closeTo(result.stats.get("armor")?.value, 6);
});

test("quality is added to the base stat roll, and to nothing else on the item", () => {
  // `int p = (int) (this.p + gear.getQualityBaseStatsBonus(stack));` — BaseStatsData.GetAllStats,
  // confirmed against the 6.4.13 jar (a bare `iadd`, then straight into the per-stat lambda).
  // `getQualityBaseStatsBonus` returns the stored int with no arithmetic on it, so 20 quality is
  // 20 percentage points on the roll rather than a multiplier.
  const result = calculate(
    withGear([
      {
        base: "boots",
        rarity: "common",
        itemLevel: 1,
        baseRolls: [50],
        quality: 20,
        suffixes: [{ affixId: "of_the_bear", tier: "common", rollPercent: 50 }],
      },
    ]),
    SNAPSHOT,
  );

  // The base rolls at 70%, not 50: 4 + 4 * 0.7 = 6.8. The suffix stays at its own 50% — 15 —
  // because nothing but `BaseStatsData` reads quality at all, and an implementation that
  // applied it to the whole item would read 22.8 here.
  closeTo(result.stats.get("armor")?.value, 21.8);
});

test("quality pushes the base roll past 100%, because nothing clamps the sum", () => {
  // The band in `BaseStatsData.getMinMax` bounds the *stored* roll; quality is added after it
  // and the sum is never re-clamped. A perfect item with quality on it is therefore worth more
  // than the base type's declared maximum, which looks like a bug and is the mechanic.
  const result = calculate(
    withGear([{ base: "boots", rarity: "common", itemLevel: 1, baseRolls: [100], quality: 20 }]),
    SNAPSHOT,
  );

  // 4 + 4 * 1.2 = 8.8, above the base's own max of 8.
  closeTo(result.stats.get("armor")?.value, 8.8);
});
