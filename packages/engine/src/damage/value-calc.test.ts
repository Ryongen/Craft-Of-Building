/**
 * `mmorpg_value_calc`.
 *
 * The interesting parts are the two different level scalings and the truncations. Getting the
 * spell-level denominator wrong is the single easiest mistake here — it is
 * `max_lvl + MAX_BONUS_SPELL_LEVELS`, not `max_lvl`, so a spell at its own maximum reads well
 * short of its `max` value.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { balance } from "../balance.js";
import { ORIGINAL_MODE } from "../compat.js";
import { closeTo, engineSnapshot, valueCalcEntry } from "../test-support.js";
import { baseValue, calculatedValue, leveledValue, valueCalc } from "./value-calc.js";

const snapshot = engineSnapshot({
  mmorpg_value_calc: {
    plain: valueCalcEntry("plain", { min: 10, max: 20 }),
    weapon: valueCalcEntry("weapon", { min: 0, max: 0 }, [{ stat: "weapon_damage", min: 1, max: 2 }]),
    capped: valueCalcEntry(
      "capped",
      { min: 0, max: 0 },
      [
        { stat: "weapon_damage", min: 1, max: 1 },
        { stat: "mana", min: 1, max: 1 },
      ],
      { cap_to_wep_dmg: 2 },
    ),
    flat: valueCalcEntry("flat", { min: 7, max: 7 }, [], { base_scaling_type: "NONE" }),
  },
});

const bal = balance(snapshot);

test("leveledValue interpolates over max_lvl plus the balance bonus, not max_lvl", () => {
  // `original_balance` sets MAX_BONUS_SPELL_LEVELS to 8, so a 16-level spell divides by 24.
  assert.equal(leveledValue({ min: 0, max: 24 }, 0, 24), 0);
  assert.equal(leveledValue({ min: 0, max: 24 }, 24, 24), 24);
  // At its own max_lvl of 16 the spell reads 16/24 of the band — not the top.
  assert.equal(leveledValue({ min: 0, max: 24 }, 16, 24), 16);
});

test("leveledValue short-circuits when min equals max", () => {
  assert.equal(leveledValue({ min: 5, max: 5 }, 0, 24), 5);
  assert.equal(leveledValue({ min: 5, max: 5 }, 99, 24), 5);
});

test("base scales on character level and truncates", () => {
  const calc = valueCalc(snapshot, "plain");
  assert.ok(calc);
  // NORMAL at level 1 is a multiplier of 1, so this is the raw interpolation, truncated.
  // 10 + (20-10)/24 * 12 = 15
  assert.equal(baseValue(calc, 12, 24, 1, bal, ORIGINAL_MODE), 15);
  // At level 11 the NORMAL curve is 1 + 0.2*10 = 3.
  assert.equal(baseValue(calc, 12, 24, 11, bal, ORIGINAL_MODE), 45);
});

test("base_scaling_type NONE ignores character level", () => {
  const calc = valueCalc(snapshot, "flat");
  assert.ok(calc);
  assert.equal(baseValue(calc, 0, 24, 1, bal, ORIGINAL_MODE), 7);
  assert.equal(baseValue(calc, 0, 24, 100, bal, ORIGINAL_MODE), 7);
});

test("stat scalings read the caster sheet and truncate per term", () => {
  const calc = valueCalc(snapshot, "weapon");
  assert.ok(calc);
  const caster = (id: string) => (id === "weapon_damage" ? 33 : 0);
  // multi at spell level 12 of 24 = 1 + (2-1)/24*12 = 1.5, times 33 = 49.5 -> 49.
  assert.equal(calculatedValue(calc, caster, null, 12, 24, 1, bal, ORIGINAL_MODE), 49);
});

test("cap_to_wep_dmg limits the non-weapon terms to a multiple of weapon damage", () => {
  const calc = valueCalc(snapshot, "capped");
  assert.ok(calc);
  // weapon_damage 10 -> dmg 10; mana 500 -> other 500, capped to 10 * 2 = 20. Total 30.
  const caster = (id: string) => (id === "weapon_damage" ? 10 : id === "mana" ? 500 : 0);
  assert.equal(calculatedValue(calc, caster, null, 24, 24, 1, bal, ORIGINAL_MODE), 30);
});

test("a cap_to_wep_dmg of 1000 does not cap: the threshold is 50", () => {
  // `capsToWeaponDamage()` is `cap_to_wep_dmg < 50`, so the default of 1000 means no cap at
  // all rather than a very high one.
  const calc = valueCalc(snapshot, "weapon");
  assert.ok(calc);
  assert.equal(calc.capToWeaponDamage, 1000);
  const caster = (id: string) => (id === "weapon_damage" ? 1 : 0);
  closeTo(calculatedValue(calc, caster, null, 24, 24, 1, bal, ORIGINAL_MODE), 2);
});

test("an unknown value calc id resolves to undefined rather than zero", () => {
  assert.equal(valueCalc(snapshot, "nope"), undefined);
});
