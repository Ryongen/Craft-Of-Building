import assert from "node:assert/strict";
import { test } from "node:test";

import { TARGET_PRESETS, buildTargetEnemy } from "./target-presets.js";
import { BALANCE, RARITIES, makeSnapshot } from "./test-support.js";

/**
 * The pack's own mob rarities. `stat_multi` is the whole definition of a rarity preset:
 * `MobStatUtils` gives `10 * stat_multi` of armour through the level curve and that same number
 * again, flat, as every non-physical resist.
 */
const SNAPSHOT = makeSnapshot({
  mmorpg_gear_rarity: RARITIES,
  mmorpg_game_balance: {
    original_balance: {
      ...BALANCE,
      MAX_LEVEL: 100,
      NORMAL_STAT_SCALING: { base_scaling: 1, per_level_scaling: 0.2, cap_to_max_lvl: false },
    },
  },
  mmorpg_mob_rarity: {
    common: { id: "common", stat_multi: 1 },
    boss: { id: "boss", stat_multi: 3.5 },
  },
});

/** `getMultiFor(100)` on NORMAL: `1 + 0.2 * 99`. */
const CURVE_AT_100 = 20.8;

test("a rarity preset is 10 x stat_multi, scaled for armour and flat for resists", () => {
  const boss = buildTargetEnemy(SNAPSHOT, "map_boss", 100);
  assert.equal(boss.armor, 10 * 3.5 * CURVE_AT_100);
  // `ExactStatData.noScaling` — the same number at every level.
  assert.equal(boss.resists?.["fire"], 35);
  assert.equal(buildTargetEnemy(SNAPSHOT, "map_boss", 1).resists?.["fire"], 35);
  // `getAllSingle()` is iterated with Physical skipped, so no mob has physical resistance.
  assert.equal("physical" in (boss.resists ?? {}), false);
});

test("max resist solves armour for 75% mitigation rather than copying a boss's", () => {
  const target = buildTargetEnemy(SNAPSHOT, "max_resist", 100);

  // `setArmourForMitigation(profile, level, 0.75F)`: base is `100 * curve`, and the inverse of
  // `v / (v + base)` at 0.75 is `base * 3`.
  const base = 100 * CURVE_AT_100;
  assert.equal(target.armor, (base * 0.75) / 0.25);

  // Which is three times what a boss carries — the bug this replaced, in one line.
  const boss = buildTargetEnemy(SNAPSHOT, "map_boss", 100);
  assert.ok((target.armor ?? 0) > (boss.armor ?? 0) * 8);

  // And it really does buy 75%, at any level.
  for (const level of [1, 20, 60, 100]) {
    const at = buildTargetEnemy(SNAPSHOT, "max_resist", level);
    const scale = 100 * (1 + 0.2 * (level - 1));
    const mitigation = (at.armor ?? 0) / ((at.armor ?? 0) + scale);
    assert.ok(Math.abs(mitigation - 0.75) < 1e-9, `level ${level}: ${mitigation}`);
  }
});

test("max resist pins the max-resist stat at 15, which is what reaches the 90 cap", () => {
  const target = buildTargetEnemy(SNAPSHOT, "max_resist", 100);
  assert.equal(target.resists?.["fire"], 90);
  // `clamp(75 + max_fire_resist, min, 90)`. `MaxElementalResist.max` is 15, so 15 is the most a
  // mob can hold and exactly enough — the 90 that used to sit here is not a legal stat value.
  assert.equal(target.maxResists?.["fire"], 15);
  assert.equal("physical" in (target.maxResists ?? {}), false);
});

test("naked zeroes the defences and the offence, and states nothing else", () => {
  const naked = buildTargetEnemy(SNAPSHOT, "naked", 100);
  assert.equal(naked.armor, 0);
  assert.equal(naked.resists?.["fire"], 0);
  // Physical is included here: Naked zeroes everything, and a zero it does not have reads 0.
  assert.equal(naked.resists?.["physical"], 0);
  assert.equal(naked.blockChance, 0);
  assert.equal(naked.offence?.accuracy, 0);
  // Health and critical damage stay at MnS's own: zero is not a meaningful value for either,
  // and the dummy's `keepsMnsDefault` leaves both alone for the same reason.
  assert.equal("critDamage" in (naked.offence ?? {}), false);
});

test("a rarity the pack does not have falls back to common rather than to nothing", () => {
  // `setRarity` checks `rarityStatMultiplier(...) > 0` before using a rarity, and so does this.
  const uber = buildTargetEnemy(SNAPSHOT, "uber_boss", 100);
  assert.equal(uber.armor, 10 * 1 * CURVE_AT_100);
});

test("no target preset states an attack damage, because none of them can know one", () => {
  // The invariant the whole incoming model rests on, pinned so a future edit cannot quietly
  // break it. `mobOffence()`'s own docstring says its zeroes are a finding rather than a
  // placeholder: `MobStatUtils.getMobBaseStats` gives a mob one line of offence, and it is
  // accuracy. A preset that started filling in a hit would put a number under every defensive
  // figure that no file in the install says, and would move every existing document's numbers
  // the moment it shipped.
  //
  // An attacker profile is the explicit second click instead. See `ATTACKER_PROFILES`.
  for (const preset of TARGET_PRESETS) {
    const enemy = buildTargetEnemy(SNAPSHOT, preset.id, 100);
    assert.equal(
      enemy.offence?.vanillaAttackDamage,
      undefined,
      `${preset.id} must not invent an attack damage`,
    );
    assert.equal(
      enemy.offence?.attacksPerSecond,
      undefined,
      `${preset.id} must not invent an attack rate`,
    );
  }
});
