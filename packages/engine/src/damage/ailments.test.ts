/**
 * An ailment is a second damage event.
 *
 *     var event = EventBuilder.ofDamage(source, target, dmg)
 *             .setupDamage(AttackType.dot, WeaponTypes.none, PlayStyle.INT)
 *             .set(x -> { x.disableActivation = true; x.setElement(ailment.element);
 *                         x.setisAilmentDamage(ailment); }).build();
 *     event.Activate();
 *     Load.Unit(target).ailments.onAilmentCausingDamage(..., event.data.getNumber(), unit);
 *
 * — `AilmentChance.activate`. The arithmetic in `onAilmentCausingDamage` was already ported; what
 * this pins is the number it is handed, which used to be the pre-layer base and so missed every
 * additive stat the game gives a DoT.
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
  spellEntry,
  statEntry,
  valueCalcEntry,
} from "../test-support.js";
import { simulateHit } from "./simulate.js";

const EFFECTS = {
  /** `BaseDamageIncreaseEffect` — where `AilmentDamage` and `AllAilmentDamage` both write. */
  add_additive: {
    id: "add_additive",
    ser: "modify_stat_layer",
    layer: "additive_damage",
    modification: "ADD",
    num_provider: { type: "STAT_DATA", calc: "" },
  },
};

const CONDITIONS = {
  /** The pack's own gate on the thirteen attack-only stats: a DoT's style is always `int`. */
  style_is_int_is_false: condition("style_is_int_is_false", "string_matches", {
    string_key: "style",
    string_id: "int",
    is: false,
  }),
};

/** A stat that adds to `additive_damage` on every damage event, gated or not. */
function additiveStat(id: string, ifs: string[] = []) {
  return statEntry(id, {
    is_perc: true,
    effect: [effectBlock("additive_damage", ["add_additive"], ifs)],
  });
}

/**
 * A physical hit that always bleeds, on a `str` spell.
 *
 * `str` matters: it is what lets the test tell the hit's own event apart from the ailment's,
 * which `AilmentChance.activate` pins to `PlayStyle.INT` whatever weapon you hold.
 */
function snapshotWith(stats: Record<string, Record<string, unknown>>, granted: Record<string, number>) {
  return engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: {
      strike: spellEntry("strike", "Physical", "hit100", {
        config: { tags: { tags: [] }, use_support_gems_from: "", style: "str", cooldown_ticks: 20 },
      }),
    },
    mmorpg_stat: { bleed_chance: statEntry("bleed_chance"), ...stats },
    mmorpg_stat_effect: EFFECTS,
    mmorpg_stat_condition: CONDITIONS,
    mmorpg_base_stats: {
      original_mode_player: baseStats(
        "original_mode_player",
        Object.entries(granted).map(([id, value]) => exact(id, "FLAT", value)),
      ),
    },
  });
}

const BUILD: BuildDoc = {
  schemaVersion: 1,
  character: { level: 1 },
  skills: [{ spellId: "strike", main: true }],
} as BuildDoc;

function bleedOf(snapshot: ReturnType<typeof snapshotWith>) {
  const result = simulateHit(BUILD, snapshot, {})!;
  const bleed = result.hit.ailments.find((a) => a.ailment === "bleed");
  assert.ok(bleed !== undefined, "expected a bleed");
  return bleed;
}

test("an ailment's base is what its own event made of the hit's, not the hit's", () => {
  // `ailment_damage` is `AllAilmentDamage`, a code-only stat, so it needs no registry entry —
  // only a value on the sheet. Its `canActivate` is `!getString(AILMENT).isEmpty()`, which no
  // event but the ailment's own can satisfy.
  const plain = bleedOf(snapshotWith({}, { bleed_chance: 100 }));
  // With nothing additive on the sheet the second event is the identity, so the two agree and
  // the old floor was right by accident.
  closeTo(plain.eventDamage, plain.hitBase);

  const boosted = bleedOf(snapshotWith({}, { bleed_chance: 100, ailment_damage: 50 }));
  // `additive_damage` is a 1 + sum/100 multiplier, so +50% is x1.5 on the ailment's own event.
  closeTo(boosted.hitBase, plain.hitBase);
  closeTo(boosted.eventDamage, plain.eventDamage * 1.5);
  closeTo(boosted.damagePerSecond, plain.damagePerSecond * 1.5);

  // `bleed_damage` is `AilmentDamage`, the per-ailment twin: it matches on the id, so a burn
  // stat leaves a bleed alone.
  const bleedOnly = bleedOf(snapshotWith({}, { bleed_chance: 100, bleed_damage: 50 }));
  closeTo(bleedOnly.eventDamage, plain.eventDamage * 1.5);
  const burnOnly = bleedOf(snapshotWith({}, { bleed_chance: 100, burn_damage: 50 }));
  closeTo(burnOnly.eventDamage, plain.eventDamage);

  // And neither reaches the hit that inflicted it: the hit carries no `AILMENT`.
  closeTo(boosted.hitBase, bleedOnly.hitBase);
});

test("the ailment's event is `int`, whatever the spell that inflicted it is", () => {
  // `attack_damage` and its twelve siblings carry `style_is_int_is_false`. The spell is `str`, so
  // the hit takes the bonus; `AilmentChance.activate` writes `PlayStyle.INT` as a literal, so the
  // ailment does not.
  const snapshot = snapshotWith(
    { attack_damage: additiveStat("attack_damage", ["style_is_int_is_false"]) },
    { bleed_chance: 100, attack_damage: 100 },
  );
  const bare = snapshotWith(
    { attack_damage: additiveStat("attack_damage", ["style_is_int_is_false"]) },
    { bleed_chance: 100 },
  );

  const withStat = simulateHit(BUILD, snapshot, {})!;
  const without = simulateHit(BUILD, bare, {})!;

  // The hit doubled: it is a `str` spell, so the gate passed.
  closeTo(withStat.hit.total, without.hit.total * 2);

  // The bleed did not, because its own event is `int` and the gate failed there.
  const a = withStat.hit.ailments.find((x) => x.ailment === "bleed")!;
  const b = without.hit.ailments.find((x) => x.ailment === "bleed")!;
  closeTo(a.eventDamage, b.eventDamage);
});

test("an ailment cannot inflict an ailment", () => {
  // `AilmentChance.canActivate` requires `hit` or `bonus_dmg`; the second event is `dot`. Without
  // that guard a bleeding hit would bleed itself forever.
  const result = simulateHit(BUILD, snapshotWith({}, { bleed_chance: 100 }), {})!;
  assert.equal(result.hit.ailments.filter((a) => a.ailment === "bleed").length, 1);
});
