import assert from "node:assert/strict";
import { test } from "node:test";

import type { BuildDoc } from "@cte2/schema";

import { calculate } from "../calculate.js";
import { baseStats, engineSnapshot, exact, statEntry } from "../test-support.js";
import { newbieResistValue } from "./newbie-resists.js";

function build(level: number): BuildDoc {
  return { schemaVersion: 1, character: { level } };
}

/** The four resists the grant touches, plus the pack's own -25 base on each. */
function snapshot() {
  return engineSnapshot({
    mmorpg_stat: {
      elemental_resist: statEntry("elemental_resist"),
      fire_resist: statEntry("fire_resist"),
      water_resist: statEntry("water_resist"),
      lightning_resist: statEntry("lightning_resist"),
      chaos_resist: statEntry("chaos_resist"),
    },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("elemental_resist", "FLAT", -25),
        exact("chaos_resist", "FLAT", -25),
      ]),
    },
  });
}

test("the grant steps down at 25, 50 and 75 and then stops", () => {
  // `if (lvl > 24)`, not `>= 25` — level 24 still has the full grant and 25 does not.
  assert.equal(newbieResistValue(1), 50);
  assert.equal(newbieResistValue(24), 50);
  assert.equal(newbieResistValue(25), 25);
  assert.equal(newbieResistValue(49), 25);
  assert.equal(newbieResistValue(50), 0);
  assert.equal(newbieResistValue(74), 0);
  assert.equal(newbieResistValue(75), -25);
  // The last `if` has nothing after it, so 100 is not a fourth step down.
  assert.equal(newbieResistValue(100), -25);
});

test("a level 1 character reads +25 on every resist, not -25", () => {
  // The number both captured fixtures pin: `original_mode_player` grants -25 and the newbie
  // grant +50. Reading the base alone gives -25 and misses by exactly 50.
  const stats = calculate(build(1), snapshot()).stats;
  for (const id of ["fire_resist", "water_resist", "lightning_resist", "chaos_resist"]) {
    assert.equal(stats.get(id)?.value, 25, id);
  }
});

test("a level 100 character reads -50, the base and the grant both negative", () => {
  const stats = calculate(build(100), snapshot()).stats;
  for (const id of ["fire_resist", "water_resist", "lightning_resist", "chaos_resist"]) {
    assert.equal(stats.get(id)?.value, -50, id);
  }
});

test("chaos is included and physical is not", () => {
  // `Elements.getAllSingle()` minus Physical — Shadow (chaos) is in, and physical_resist gets
  // nothing even though it is a single element.
  const result = calculate(build(1), snapshot());
  const ctx = result.contexts.find((c) => c.type === "NEWBIE_RESISTS");
  assert.ok(ctx, "a NEWBIE_RESISTS context is produced");
  assert.deepEqual(
    ctx.stats.map((m) => m.statId).sort(),
    ["chaos_resist", "fire_resist", "lightning_resist", "water_resist"],
  );
});

test("the grant can be turned off, as CompatConfig can turn it off", () => {
  const stats = calculate(build(1), snapshot(), { newbieResists: false }).stats;
  assert.equal(stats.get("fire_resist")?.value, -25);
  assert.equal(stats.get("chaos_resist")?.value, -25);
});

test("resist mitigation truncates the value, because getUsableValue takes an int", () => {
  // `getUsableValue(Unit, int value, int lvl)` with `(int) data.getValue()` at every call
  // site: a 25.2% resist mitigates 25%, not 25.2%.
  const snap = engineSnapshot({
    mmorpg_stat: { fire_resist: statEntry("fire_resist") },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [exact("fire_resist", "FLAT", -24.8)]),
    },
  });
  // -24.8 from the base, +50 from the grant = 25.2.
  const stat = calculate(build(1), snap).stats.get("fire_resist");
  assert.equal(stat?.value, 25.2);
  assert.equal(stat?.usableValue, 25);
});

test("the 6.4.13 caps override the 6.4.8 table the porter produced", () => {
  // Both captures observe these off the live registered `Stat.max`; the generated table is
  // ported from a source checkout five patches older. If a regeneration against matching
  // source ever lands, these stay true and CODE_ONLY_SHAPE_OVERRIDES becomes a no-op.
  const snap = engineSnapshot({
    mmorpg_stat: {},
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("electrify_proc_chance", "FLAT", 10),
        exact("freeze_proc_chance", "FLAT", 5),
        exact("block_chance", "FLAT", 1),
      ]),
    },
  });
  const stats = calculate(build(1), snap).stats;
  assert.equal(stats.get("electrify_proc_chance")?.hardcap, 100);
  assert.equal(stats.get("freeze_proc_chance")?.hardcap, 100);
  assert.equal(stats.get("block_chance")?.hardcap, 90);
});

test("vanilla hearts are added into the health pool, before the multipliers", () => {
  // `InCalc.addVanillaHpToStats`: `addAlreadyScaledFlat(Mth.clamp(getMaxHealth(), 0, 500))`,
  // and `addAlreadyScaledFlat` is `this.Flat += val`. A bare level 1 reads 100, not 80 —
  // 80 from `original_mode_player` plus vanilla's own 20. Heart Containers raise the vanilla
  // attribute, so they reach MnS health through exactly this path.
  const snap = engineSnapshot({
    mmorpg_stat: { health: statEntry("health") },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [exact("health", "FLAT", 80)]),
    },
  });
  const doc = (maxHealth?: number): BuildDoc => ({
    schemaVersion: 1,
    character: { level: 1, ...(maxHealth === undefined ? {} : { attributes: { "minecraft:generic.max_health": maxHealth } }) },
  });

  assert.equal(calculate(doc(20), snap).stats.get("health")?.value, 100);
  // 100 collected hearts' worth.
  assert.equal(calculate(doc(220), snap).stats.get("health")?.value, 300);
  // `Mth.clamp(..., 0, 500)` — anything past 500 contributes 500.
  assert.equal(calculate(doc(900), snap).stats.get("health")?.value, 580);
  // Nothing recorded, nothing added.
  assert.equal(calculate(doc(), snap).stats.get("health")?.value, 80);
  // And the config gate, like newbieResists.
  assert.equal(calculate(doc(220), snap, { vanillaHealth: false }).stats.get("health")?.value, 80);
});

test("block chance mitigation has no 90 ceiling, unlike a resist", () => {
  // `clamp((float) value, min, BASE_BLOCK_CAP + max_block_chance)` — 75 base, raised by
  // `max_block_chance`, and *not* clamped to 90 the way `ElementalResist` clamps its ceiling.
  const snap = engineSnapshot({
    mmorpg_stat: { block_chance: statEntry("block_chance"), max_block_chance: statEntry("max_block_chance") },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("block_chance", "FLAT", 26.32),
      ]),
    },
  });
  const stat = calculate({ schemaVersion: 1, character: { level: 1 } }, snap).stats.get("block_chance");
  // The `(int)` on the parameter truncates, so 26.32 mitigates 26.
  assert.equal(stat?.usableValue, 26);

  // Past the base cap it clamps at 75 with no `max_block_chance`...
  const high = engineSnapshot({
    mmorpg_stat: { block_chance: statEntry("block_chance"), max_block_chance: statEntry("max_block_chance") },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("block_chance", "FLAT", 200),
        exact("max_block_chance", "FLAT", 20),
      ]),
    },
  });
  // ...and 75 + 20 = 95 with it, which is past where any resist could go.
  assert.equal(calculate({ schemaVersion: 1, character: { level: 1 } }, high).stats.get("block_chance")?.usableValue, 95);
});
