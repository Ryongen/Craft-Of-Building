import assert from "node:assert/strict";
import { test } from "node:test";

import type { BuildDoc } from "@cte2/schema";

import { calculate } from "../calculate.js";
import { baseStats, engineSnapshot, exact, statEntry } from "../test-support.js";

/** Two of the pack's real entries, plus one enchant entry and one circular one. */
function snapshot() {
  return engineSnapshot({
    mmorpg_base_gear_types: {
      sword: { guid: "sword", weapon_type: "sword", gear_slot: "sword" },
      boots: { guid: "boots", weapon_type: "none", gear_slot: "boots" },
    },
    mmorpg_stat: {
      magic_shield: statEntry("magic_shield"),
      weapon_damage: statEntry("weapon_damage"),
      total_damage: statEntry("total_damage"),
      // `attack_speed` is an AttributeStat: it pushes outward onto a vanilla attribute, so
      // compat must not read it back in.
      attack_speed: { id: "attack_speed", ser: "vanilla_attribute_stat_ser", data: { attribute_id: "minecraft:generic.attack_speed" } },
    },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("magic_shield", "FLAT", 1000),
        exact("weapon_damage", "FLAT", 100),
      ]),
    },
    mmorpg_stat_compat: {
      health_compat: {
        id: "health_compat",
        attribute_id: "minecraft:generic.max_health",
        enchant_id: "",
        scaling: "NONE",
        mns_stat_id: "magic_shield",
        conversion: 0.5,
        minimum_cap: 0,
        maximum_cap: 100,
        mod_type: "PERCENT",
      },
      kube_weapon_damage: {
        id: "kube_weapon_damage",
        attribute_id: "kubejs:weapon_damage",
        enchant_id: "",
        scaling: "NONE",
        mns_stat_id: "weapon_damage",
        conversion: 1,
        minimum_cap: 0,
        maximum_cap: 100,
        mod_type: "PERCENT",
      },
      fire_protection_compat: {
        id: "fire_protection_compat",
        attribute_id: "",
        enchant_id: "minecraft:fire_protection",
        scaling: "NONE",
        mns_stat_id: "magic_shield",
        conversion: 2,
        minimum_cap: 0,
        maximum_cap: 36,
        // The pack's real values: at most 12 from any one piece, 36 across all of them.
        per_item_min: 0,
        per_item_max: 12,
        mod_type: "FLAT",
      },
      // The pack's real entry, and the only one that decides damage.
      attack_damage_compat: {
        id: "attack_damage_compat",
        attribute_id: "minecraft:generic.attack_damage",
        enchant_id: "",
        scaling: "NONE",
        mns_stat_id: "total_damage",
        conversion: 0.5,
        minimum_cap: 0,
        maximum_cap: 100,
        mod_type: "FLAT",
      },
      circular: {
        id: "circular",
        attribute_id: "minecraft:generic.attack_speed",
        enchant_id: "",
        scaling: "NONE",
        mns_stat_id: "attack_speed",
        conversion: 10,
        minimum_cap: 0,
        maximum_cap: 100,
        mod_type: "FLAT",
      },
    },
  });
}

/** A build whose gear carries the given enchantment maps, one entry per piece. */
function withEnchantedGear(enchantments: Record<string, number>[]): BuildDoc {
  return {
    schemaVersion: 1,
    character: { level: 1, attributes: {} },
    gear: enchantments.map((e) => ({
      base: "boots",
      rarity: "common",
      itemLevel: 1,
      enchantments: e,
    })),
  };
}

function build(attributes?: Record<string, number>): BuildDoc {
  return {
    schemaVersion: 1,
    character: { level: 1, ...(attributes === undefined ? {} : { attributes }) },
  };
}

test("a vanilla attribute converts into a real stat at the entry's conversion", () => {
  // Solonion's food diversity is +1.0 to `kubejs:weapon_damage` at its first threshold, and
  // `kube_weapon_damage` converts that 1:1 into a PERCENT — the +1% the level 1 capture shows.
  const stats = calculate(build({ "kubejs:weapon_damage": 1 }), snapshot()).stats;
  assert.equal(stats.get("weapon_damage")?.value, 101);
});

test("the conversion reads the attribute total and truncates it", () => {
  // `(int) (getAttributeValue(at) * conversion)`: 41 * 0.5 = 20.5 -> 20, so +20%.
  const stats = calculate(build({ "minecraft:generic.max_health": 41 }), snapshot()).stats;
  assert.equal(stats.get("magic_shield")?.value, 1200);
});

test("the result is clamped to the entry's caps", () => {
  // 0.5 * 400 = 200, clamped to maximum_cap 100.
  const stats = calculate(build({ "minecraft:generic.max_health": 400 }), snapshot()).stats;
  assert.equal(stats.get("magic_shield")?.value, 2000);
});

test("a conversion that lands on zero contributes nothing", () => {
  // `if (value != 0)` — 1 * 0.5 truncates to 0, so no modifier at all rather than a zero one.
  const result = calculate(build({ "minecraft:generic.max_health": 1 }), snapshot());
  assert.equal(result.stats.get("magic_shield")?.value, 1000);
  const ctx = result.contexts.find((c) => c.type === "VANILLA_STAT_COMPAT");
  assert.ok(!ctx || !ctx.stats.some((m) => m.statId === "magic_shield"));
});

test("an AttributeStat is never fed from its own attribute", () => {
  // `if (ExileDB.Stats().get(mns_stat_id) instanceof AttributeStat) { return null; }` — the
  // stat pushes onto the attribute, so reading it back would be circular.
  const result = calculate(build({ "minecraft:generic.attack_speed": 4 }), snapshot());
  const ctx = result.contexts.find((c) => c.type === "VANILLA_STAT_COMPAT");
  assert.ok(!ctx || !ctx.stats.some((m) => m.statId === "attack_speed"));
});

/** A build holding one gear base, with whatever attributes the capture claims. */
function withGear(base: string, attributes: Record<string, number>): BuildDoc {
  return {
    schemaVersion: 1,
    character: { level: 1, attributes },
    gear: [{ base, rarity: "common", itemLevel: 1 }],
  };
}

test("a weapon equipped against a bare-handed attack_damage attribute is reported", () => {
  // Vanilla's player base is 1.0 and every weapon in the pack raises it, so this pair can only
  // mean the capture was taken before the weapon went on — F6 first, equip second.
  for (const attrs of [{}, { "minecraft:generic.attack_damage": 1 }]) {
    const result = calculate(withGear("sword", attrs), snapshot());
    assert.ok(
      result.diagnostics.some((d) => d.code === "weapon-attack-damage-unrecorded"),
      `expected the warning for ${JSON.stringify(attrs)}`,
    );
    // And the cost of it: no `total_damage` at all, which is additive damage on every element.
    assert.equal(result.stats.get("total_damage")?.value ?? 0, 0);
  }
});

test("a recorded weapon attack damage is silent, and converts at 0.5x", () => {
  // The Lagionaire capture: `generic.attack_damage` 9 with the sword in hand -> trunc(4.5) = 4,
  // which is the x1.57 the game's damage log printed rather than the x1.53 without it.
  const result = calculate(withGear("sword", { "minecraft:generic.attack_damage": 9 }), snapshot());
  assert.ok(!result.diagnostics.some((d) => d.code === "weapon-attack-damage-unrecorded"));
  assert.equal(result.stats.get("total_damage")?.value, 4);
});

test("armour at the bare-handed attack damage is not a stale capture", () => {
  // `weapon_type: "none"` — a character wearing only boots really does have 1.0.
  const result = calculate(withGear("boots", { "minecraft:generic.attack_damage": 1 }), snapshot());
  assert.ok(!result.diagnostics.some((d) => d.code === "weapon-attack-damage-unrecorded"));
});

test("with no attributes recorded nothing applies, and the engine says so", () => {
  const result = calculate(build(), snapshot());
  assert.equal(result.stats.get("magic_shield")?.value, 1000);
  assert.ok(result.diagnostics.some((d) => d.code === "vanilla-attributes-unknown"));
});

test("enchantment compat sums across pieces, clamped per item and then in total", () => {
  // fire_protection_compat: conversion 2, per_item_max 12, maximum_cap 36, FLAT magic_shield.
  // Three pieces at level 4 -> trunc(4*2)=8 each, 24 total, under both caps.
  const three = calculate(
    withEnchantedGear([
      { "minecraft:fire_protection": 4 },
      { "minecraft:fire_protection": 4 },
      { "minecraft:fire_protection": 4 },
    ]),
    snapshot(),
  ).stats;
  assert.equal(three.get("magic_shield")?.value, 1024);

  // One piece at level 40 would be 80, but the per-item clamp holds it to 12.
  const one = calculate(
    withEnchantedGear([{ "minecraft:fire_protection": 40 }]),
    snapshot(),
  ).stats;
  assert.equal(one.get("magic_shield")?.value, 1012);

  // Five pieces at 12 each is 60, clamped to the entry's maximum_cap of 36.
  const five = calculate(
    withEnchantedGear(Array.from({ length: 5 }, () => ({ "minecraft:fire_protection": 6 }))),
    snapshot(),
  ).stats;
  assert.equal(five.get("magic_shield")?.value, 1036);
});

test("an enchantment below level 1 contributes nothing", () => {
  // `if (enchlvl < 1) { continue; }`
  const stats = calculate(withEnchantedGear([{ "minecraft:fire_protection": 0 }]), snapshot()).stats;
  assert.equal(stats.get("magic_shield")?.value, 1000);
});

test("food diversity derives the attributes when none were captured", () => {
  // Solonion grants `kubejs:weapon_damage` +1.0 at 3 distinct foods, which `kube_weapon_damage`
  // converts 1:1 into a PERCENT.
  const snap = snapshot();
  snap.externalConfig = {
    ...snap.externalConfig,
    foodDiversity: {
      trackCount: 48,
      minFoodsToActivate: 0,
      resetOnDeath: false,
      benefits: [
        { threshold: 3, attributeId: "kubejs:weapon_damage", operation: 0, value: 1, raw: "" },
        { threshold: 9, attributeId: "kubejs:weapon_damage", operation: 0, value: 1, raw: "" },
      ],
    },
  };

  const below = calculate({ schemaVersion: 1, character: { level: 1, foodDiversity: 2 } }, snap).stats;
  assert.equal(below.get("weapon_damage")?.value, 100);

  // At 3 the first benefit applies; at 9 both do, and they stack.
  const at3 = calculate({ schemaVersion: 1, character: { level: 1, foodDiversity: 3 } }, snap).stats;
  assert.equal(at3.get("weapon_damage")?.value, 101);
  const at9 = calculate({ schemaVersion: 1, character: { level: 1, foodDiversity: 9 } }, snap).stats;
  assert.equal(at9.get("weapon_damage")?.value, 102);
});

/** A pack whose only food benefit is `kubejs:weapon_damage`, for the capture-merge tests. */
function foodSnapshot() {
  const snap = snapshot();
  snap.externalConfig = {
    ...snap.externalConfig,
    foodDiversity: {
      trackCount: 48,
      minFoodsToActivate: 0,
      resetOnDeath: false,
      benefits: [{ threshold: 3, attributeId: "kubejs:weapon_damage", operation: 0, value: 1, raw: "" }],
    },
  };
  return snap;
}

test("a captured attribute the game actually reported wins over food diversity", () => {
  // The capture recorded 5, which already has whatever the character had eaten in it. Adding
  // the stated diversity on top would count the same food twice.
  const result = calculate(
    { schemaVersion: 1, character: { level: 1, foodDiversity: 30, attributes: { "kubejs:weapon_damage": 5 } } },
    foodSnapshot(),
  );
  assert.equal(result.stats.get("weapon_damage")?.value, 105);
  assert.ok(!result.diagnostics.some((d) => d.code === "food-diversity-filled-gaps"));
});

test("food diversity fills an attribute the capture read as zero", () => {
  // The real failure this exists for: the exporter reads the `kubejs:` attributes client-side
  // and they come back 0 while `minecraft:generic.max_health` comes back right. Under the old
  // rule the whole diversity was dropped on the grounds that the capture had it.
  const result = calculate(
    { schemaVersion: 1, character: { level: 1, foodDiversity: 30, attributes: { "kubejs:weapon_damage": 0 } } },
    foodSnapshot(),
  );
  assert.equal(result.stats.get("weapon_damage")?.value, 101);
  assert.ok(result.diagnostics.some((d) => d.code === "food-diversity-filled-gaps"));
});

test("food diversity fills an attribute the capture omitted entirely", () => {
  const result = calculate(
    { schemaVersion: 1, character: { level: 1, foodDiversity: 30, attributes: { "minecraft:generic.luck": 3 } } },
    foodSnapshot(),
  );
  assert.equal(result.stats.get("weapon_damage")?.value, 101);
});
