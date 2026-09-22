/**
 * The mob's basic attack, pinned term by term.
 *
 *     num = (data.getAmount() * CompatConfig.get().mobPercentBonusDamage() / 100f)
 *             + CompatConfig.get().mobFlatDmg();
 *     num *= multi;
 *     num = StatScaling.MOB_DAMAGE.scale(num, getLevel()); // this should be scaled last
 *
 * — `EntityData.mobBasicAttack`, verified against `Mine_and_Slash-1.20.1-6.4.13.jar`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closeTo, engineSnapshot } from "../test-support.js";
import { ORIGINAL_MODE } from "../compat.js";
import { MAX_BASIC_ATTACKS_PER_SECOND, mobAttackRate, mobHitSize } from "./incoming.js";

const SNAPSHOT = engineSnapshot({});

test("an unstated attack damage is undefined, not zero", () => {
  // The distinction the whole feature rests on. A mob that hits for nothing and a mob nobody has
  // described are different answers, and only one of them is a reason to print a figure — so
  // this is what keeps every existing document, capture and fixture producing what it produces
  // today until a human types a number.
  assert.equal(mobHitSize(SNAPSHOT, undefined, 100, ORIGINAL_MODE), undefined);
  assert.equal(mobHitSize(SNAPSHOT, {}, 100, ORIGINAL_MODE), undefined);
  assert.equal(
    mobHitSize(SNAPSHOT, { vanillaAttackDamage: 0 }, 100, ORIGINAL_MODE),
    undefined,
    "a stated zero is still not a hit",
  );

  assert.equal(mobAttackRate(undefined), undefined);
  assert.equal(mobAttackRate({}), undefined);
});

test("the compat terms are an addition, so the flat 6 dominates a small attribute", () => {
  // `ORIGINAL_MODE` is 0.33% and a flat 6. A zombie's 3.0 contributes 0.0099 of the 6.0099 —
  // which is the counter-intuitive thing worth pinning: at level 1 nearly all of a mob's hit is
  // the flat term, and the vanilla attribute barely matters.
  const zombie = mobHitSize(SNAPSHOT, { vanillaAttackDamage: 3 }, 1, ORIGINAL_MODE)!;
  assert.ok(zombie !== undefined);
  closeTo(zombie.afterCompat, 6.0099);
  closeTo(zombie.configMulti, 1, "this pack ships vanilla_mob_dmg_as_exile_dmg 1");
  closeTo(zombie.levelMulti, 1, "the curve is 1 + 0.25 * (lvl - 1), so level 1 is the identity");
  closeTo(zombie.raw, 6.0099);

  // A vindicator swings for more than four times as much in vanilla and lands 0.03 more here.
  const vindicator = mobHitSize(SNAPSHOT, { vanillaAttackDamage: 13 }, 1, ORIGINAL_MODE)!;
  closeTo(vindicator.afterCompat, 6.0429);
});

test("the level curve is applied last, to the sum, and is x25.75 at level 100", () => {
  // `// this should be scaled last` is the mod author's own comment and it is load-bearing:
  // scaling `getAmount()` before the flat term is added would under-report every hit by most of
  // the flat 6. The pack's `original_balance` sets `per_level_scaling: 0.25`, so the curve is
  // `1 + 0.25 * 99` at level 100. (`compat_mode_balance` and the jar's own field initialiser
  // both say 0.025; the pack entry is what the game loads.)
  const at100 = mobHitSize(SNAPSHOT, { vanillaAttackDamage: 3 }, 100, ORIGINAL_MODE)!;
  closeTo(at100.levelMulti, 25.75);
  closeTo(at100.raw, 6.0099 * 25.75);
  closeTo(at100.raw, 154.754925);

  // Scaled last, not first: this is the reading that would be wrong.
  const scaledFirst = ((3 * 25.75 * ORIGINAL_MODE.mobPercentBonusDamage) / 100 + 6) * 1;
  assert.ok(
    Math.abs(at100.raw - scaledFirst) > 100,
    "the two orders are not close, so the test can tell them apart",
  );
});

test("the rate is clamped to the 5-tick basic-attack cooldown", () => {
  // `cooldowns.setOnCooldown(BASIC_ATTACK_COOLDOWN_ID, 5)` — an `iconst_5` in the 6.4.13
  // bytecode, stamped on every swing before anything else happens. So four a second is the
  // ceiling whatever the AI goal is doing, and a document asking for more is describing
  // something the game will not deliver.
  assert.equal(MAX_BASIC_ATTACKS_PER_SECOND, 4);
  closeTo(mobAttackRate({ attacksPerSecond: 1 })!, 1);
  closeTo(mobAttackRate({ attacksPerSecond: 0.5 })!, 0.5);
  closeTo(mobAttackRate({ attacksPerSecond: 20 })!, 4, "clamped, not taken at face value");
});
