/**
 * The weapon swing.
 *
 *     int num = (int) data.getAttackerEntityData().getUnit()
 *             .getCalculatedStat(WeaponDamage.getInstance()).getValue();
 *     EventBuilder.ofDamage(data, attacker, target, num)
 *             .setupDamage(AttackType.hit, weptype, data.weaponData.GetBaseGearType().style)
 *             .setIsBasicAttack()
 *
 * — `WeaponMechanic.doNormalAttack`. Three things are worth pinning: the base is the
 * `weapon_damage` stat and not a `value_calculation`, the boolean the event carries is what a
 * whole family of stats gates on, and the rate is vanilla's and so is only ever as good as the
 * `minecraft:generic.attack_speed` the document was given.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BuildDoc } from "@cte2/schema";

import {
  baseStats,
  closeTo,
  condition,
  effectBlock,
  engineSnapshot,
  exact,
  statEntry,
} from "../test-support.js";
import { baseAttackSpeedFrom, basicAttack } from "./basic-attack.js";
import { WEAPON_BASIC_ATTACK_MULTI } from "./simulate.js";

/** `is_is_basic_atk_true` — the pack's own gate, an `is_bool_true` over the event's boolean. */
const CONDITIONS = {
  is_is_basic_atk_true: condition("is_is_basic_atk_true", "is_bool_true", {
    bool_id: "is_basic_atk",
  }),
};

/**
 * A stat that adds flat damage only on a basic attack, which is the shape `BonusAttackDamage`
 * has: `effect.data.isBasicAttack() && effect.data.getAttackType() == AttackType.hit`.
 */
const SWING_ONLY = statEntry("swing_only_damage", {
  effect: [effectBlock("flat_damage", ["add_swing_damage"], ["is_is_basic_atk_true"])],
});

const EFFECTS = {
  add_swing_damage: {
    id: "add_swing_damage",
    ser: "add_to_number",
    number_id: "number",
    num_provider: { type: "STAT_DATA", calc: "" },
  },
};

function snapshotWith(stats: Record<string, number>, slotMulti?: number) {
  return engineSnapshot({
    mmorpg_stat: { swing_only_damage: SWING_ONLY, weapon_damage: statEntry("weapon_damage") },
    mmorpg_stat_condition: CONDITIONS,
    mmorpg_stat_effect: EFFECTS,
    mmorpg_base_stats: {
      original_mode_player: baseStats(
        "original_mode_player",
        Object.entries(stats).map(([id, value]) => exact(id, "FLAT", value)),
      ),
    },
    ...(slotMulti === undefined
      ? {}
      : {
          mmorpg_base_gear_types: {
            test_axe: { guid: "test_axe", gear_slot: "axe", weapon_type: "axe", base_stats: [] },
          },
          mmorpg_gear_slot: {
            axe: { id: "axe", fam: "Weapon", weapon_data: { damage_multiplier: slotMulti } },
          },
          mmorpg_gear_rarity: {
            common: { id: "common", stat_percents: { min: 0, max: 100 }, base_stat_percents: { min: 0, max: 100 } },
          },
        }),
  });
}

function build(attackSpeed?: number): BuildDoc {
  return {
    schemaVersion: 1,
    character: {
      level: 1,
      ...(attackSpeed === undefined
        ? {}
        : { attributes: { "minecraft:generic.attack_speed": attackSpeed } }),
    },
  } as BuildDoc;
}

test("a swing's base is the weapon_damage stat, truncated", () => {
  // `(int)` on the stat value, toward zero — 300.9 is a 300 hit, not 301.
  const result = basicAttack(build(2), snapshotWith({ weapon_damage: 300.9 }), {})!;
  assert.equal(result.weaponDamage, 300);
});

test("the rate is the vanilla attribute, and without it there is no rate at all", () => {
  const snapshot = snapshotWith({ weapon_damage: 100 });

  const timed = basicAttack(build(2.5), snapshot, {})!;
  assert.equal(timed.swingsPerSecond, 2.5);
  closeTo(timed.secondsPerSwing, 0.4);
  assert.equal(timed.untimed, false);
  closeTo(timed.dps, timed.hit.average.total * 2.5);

  // No capture, no attribute: the weapon's own speed modifier is a Minecraft item property and
  // nothing in a build document or a snapshot carries it, so the honest answer is none.
  const untimed = basicAttack(build(), snapshot, {})!;
  assert.equal(untimed.swingsPerSecond, undefined);
  assert.equal(untimed.untimed, true);
  assert.equal(untimed.dps, 0);
  // The hit is still real — it is only the rate beside it that is missing.
  assert.ok(untimed.hit.average.total > 0);
  assert.ok(untimed.diagnostics.some((d) => d.code === "basic-attack-untimed"));
});

test("the captured attribute alone freezes the rate, and says so", () => {
  // `attack_speed` is an `AttributeStat` with MULTIPLY_BASE, so the attribute a capture records
  // already has the character's own percent inside it. Read back whole it cannot respond to an
  // edit — which is the bug: gear worth 100% attack speed moved the swing rate not at all.
  const snapshot = snapshotWith({ weapon_damage: 100, attack_speed: 100 });
  const result = basicAttack(build(2.5), snapshot, {})!;

  assert.equal(result.swingsPerSecond, 2.5, "the capture's number, not the build's");
  assert.equal(result.frozen, true);
  assert.ok(result.diagnostics.some((d) => d.code === "basic-attack-rate-frozen"));
});

test("with the weapon's own half recorded, the rate follows attack_speed", () => {
  // `(4.0 + the item's modifier) x (1 + attack_speed / 100)`, with the left factor recorded once
  // because no registry carries it and the right one re-applied on every pass.
  const doc = {
    schemaVersion: 1,
    character: { level: 1, baseAttackSpeed: 1.2 },
  } as BuildDoc;

  const bare = basicAttack(doc, snapshotWith({ weapon_damage: 100 }), {})!;
  closeTo(bare.swingsPerSecond, 1.2);
  assert.equal(bare.frozen, false);

  const fast = basicAttack(doc, snapshotWith({ weapon_damage: 100, attack_speed: 50 }), {})!;
  closeTo(fast.swingsPerSecond, 1.8);
  closeTo(fast.dps, fast.hit.average.total * 1.8);

  // And it beats a captured attribute, which describes a character this document may have left
  // behind two edits ago.
  const withCapture = {
    ...doc,
    character: { ...doc.character, attributes: { "minecraft:generic.attack_speed": 2.5 } },
  } as BuildDoc;
  closeTo(
    basicAttack(withCapture, snapshotWith({ weapon_damage: 100, attack_speed: 50 }), {})!
      .swingsPerSecond,
    1.8,
  );
});

test("baseAttackSpeedFrom inverts the multiplier a capture baked in", () => {
  // The real numbers from the level-100 capture: 1.6818 with the sheet at 40.15%, which is an
  // axe at 1.2 swings a second.
  closeTo(baseAttackSpeedFrom(1.6818000865697869, 40.15), 1.2);
  assert.equal(baseAttackSpeedFrom(0, 40), undefined);
  // -100% attack speed is a multiplier of zero, and dividing by it is not an answer.
  assert.equal(baseAttackSpeedFrom(1.5, -100), undefined);
});

test("a stat gated on is_basic_atk reaches a swing and no cast", () => {
  const swing = basicAttack(build(1), snapshotWith({ weapon_damage: 100, swing_only_damage: 50 }), {})!;
  const bare = basicAttack(build(1), snapshotWith({ weapon_damage: 100 }), {})!;

  // The flat layer took the whole 50, which only a basic attack's event opens.
  closeTo(swing.hit.average.total - bare.hit.average.total, 50);
});

test("a swing carries no spell, so it is not a cast in disguise", () => {
  const result = basicAttack(build(1), snapshotWith({ weapon_damage: 100 }), {})!;
  // `EventData.SPELL` unset is what makes every `spell_has_tag` gate on a proc correctly fail.
  assert.equal(result.hit.spellId, "");
  // One character sheet, handed back for both halves: a swing has no spell unit to build.
  assert.equal(result.hit.sheets.character, result.hit.sheets.spell);
});

test("a swing takes the weapon slot's own basic-attack multiplier", () => {
  // `initBeforeActivating`:
  //
  //     if (this.data.isBasicAttack()) {
  //         float multi = attackInfo.weaponData.GetBaseGearType().getGearSlot().getBasicDamageMulti();
  //         this.addMoreMulti(() -> Words.WEAPON_BASIC_ATTACK_DMG_MULTI.locName(), EventData.NUMBER, multi);
  //     }
  //
  // `GearSlot.getBasicDamageMulti()` is `weapon_data.damage_multiplier`, which runs from 0.9 on a
  // gauntlet to 2.8 on a crossbow. Nothing applied it, so every swing this planner reported was
  // wrong by that factor — caught against an in-game damage log printing `x1.60` for an axe.
  const snapshot = snapshotWith({ weapon_damage: 100 }, 1.6);
  const armed: BuildDoc = {
    schemaVersion: 1,
    character: { level: 1, attributes: { "minecraft:generic.attack_speed": 1 } },
    gear: [{ base: "test_axe", rarity: "common", itemLevel: 1 }],
  } as BuildDoc;

  const result = basicAttack(armed, snapshot, { breakdown: true })!;
  const multi = result.hit.hit.trace!.moreMultis.find((m) => m.statId === WEAPON_BASIC_ATTACK_MULTI);
  assert.ok(multi, "expected a weapon basic-attack multiplier row");
  closeTo(multi.multi, 1.6);
  closeTo(result.hit.hit.total, 160);
});

test("an unarmed swing gets no weapon multiplier, matching the UNARMED_ATTACK guard", () => {
  // The guard is `if (!data.getBoolean(EventData.UNARMED_ATTACK))`. A build with no weapon also
  // has no `weapon_damage`, so this is belt and braces — but a 0.9 gauntlet and bare hands are
  // genuinely different numbers, and inventing one for an empty slot would be a silent claim.
  const result = basicAttack(build(1), snapshotWith({ weapon_damage: 100 }, 1.6), {
    breakdown: true,
  })!;
  assert.equal(
    result.hit.hit.trace!.moreMultis.some((m) => m.statId === WEAPON_BASIC_ATTACK_MULTI),
    false,
  );
  closeTo(result.hit.hit.total, 100);
});
