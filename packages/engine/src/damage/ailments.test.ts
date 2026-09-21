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

test("freeze accumulates a pool, and carries the two numbers a Shatter is worth", () => {
  // Freeze and electrify deal nothing when they land: `onAilmentCausingDamage` puts the damage
  // in `dmgMap` and `shatterAccumulated` releases the whole entry later, on a hit that rolls
  // `freeze_proc_chance`. The result therefore has to carry three things, and used to carry one
  // — the pool, without the proc chance or the decay that decide how much of it ever lands.
  const snapshot = engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: {
      shard: spellEntry("shard", "Cold", "hit100", {
        config: { tags: { tags: [] }, use_support_gems_from: "", style: "int", cooldown_ticks: 20 },
      }),
    },
    mmorpg_stat: {
      freeze_chance: statEntry("freeze_chance"),
      freeze_proc_chance: statEntry("freeze_proc_chance"),
      freeze_duration: statEntry("freeze_duration"),
    },
    mmorpg_stat_effect: EFFECTS,
    mmorpg_stat_condition: CONDITIONS,
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("freeze_chance", "FLAT", 40),
        exact("freeze_proc_chance", "FLAT", 25),
      ]),
    },
  });
  const build = {
    schemaVersion: 1,
    character: { level: 1 },
    skills: [{ spellId: "shard", main: true }],
  } as BuildDoc;

  const freeze = simulateHit(build, snapshot, {})!.hit.ailments.find((a) => a.ailment === "freeze");
  assert.ok(freeze !== undefined, "a cold hit with freeze chance has to inflict freeze");
  assert.equal(freeze.damagePerSecond, 0, "freeze never ticks — it pools");
  assert.ok(freeze.accumulated > 0, "and the pool is what it puts in");
  closeTo(freeze.chance, 0.4, "freeze_chance 40 is a 0.4 roll");
  closeTo(freeze.procChance, 0.25, "freeze_proc_chance 25 is a 0.25 roll");
  // `percentLostEveryXSeconds` is 0.1 for both strength ailments, and `decayPerSecond` divides
  // it by the duration multiplier — which is 1 here because nothing grants `freeze_duration`.
  closeTo(freeze.poolDecayPerSecond, 0.1, "10% of the pool a second while it waits");
});
test("freeze's pool is built by the same `int` dot event, so an attack stat does not reach it", () => {
  // The two strength ailments are easy to think of as a share of the hit, because that is how
  // their tooltips read — "85% of the damage is stored". They are not. `AilmentChance.activate`
  // builds the same `dot` / `none` / `INT` event for all five and hands `onAilmentCausingDamage`
  // the number it arrived at, so every gate that keeps `attack_damage` off a bleed keeps it off
  // a Shatter's pool too. This is the freeze half of the test above, pinned separately because
  // freeze takes the other branch of `resolve` and could lose the event without the DoTs
  // noticing.
  const stats = {
    freeze_chance: statEntry("freeze_chance"),
    freeze_proc_chance: statEntry("freeze_proc_chance"),
    attack_damage: additiveStat("attack_damage", ["style_is_int_is_false"]),
    // `ailment_damage` deliberately has no entry here: it is `AllAilmentDamage`, a code-only
    // stat the engine applies off the sheet alone. Giving it one as well would put it through
    // `additive_damage` twice and the control below would read x3.
  };
  const cold = (granted: Record<string, number>) =>
    engineSnapshot({
      mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
      mmorpg_spells: {
        // `str`, so the hit itself passes `style_is_int_is_false` and the ailment's own event
        // is the only thing that can fail it.
        shard: spellEntry("shard", "Cold", "hit100", {
          config: { tags: { tags: [] }, use_support_gems_from: "", style: "str", cooldown_ticks: 20 },
        }),
      },
      mmorpg_stat: stats,
      mmorpg_stat_effect: EFFECTS,
      mmorpg_stat_condition: CONDITIONS,
      mmorpg_base_stats: {
        original_mode_player: baseStats(
          "original_mode_player",
          Object.entries(granted).map(([id, value]) => exact(id, "FLAT", value)),
        ),
      },
    });

  const doc = {
    schemaVersion: 1,
    character: { level: 1 },
    skills: [{ spellId: "shard", main: true }],
  } as BuildDoc;

  const freezeOf = (granted: Record<string, number>) => {
    const result = simulateHit(doc, cold(granted), {})!;
    const freeze = result.hit.ailments.find((a) => a.ailment === "freeze");
    assert.ok(freeze !== undefined, "a cold hit with freeze chance inflicts freeze");
    return { hit: result.hit.total, freeze };
  };

  const base = freezeOf({ freeze_chance: 100, freeze_proc_chance: 50 });
  const attack = freezeOf({ freeze_chance: 100, freeze_proc_chance: 50, attack_damage: 100 });
  const ailment = freezeOf({ freeze_chance: 100, freeze_proc_chance: 50, ailment_damage: 100 });

  // The hit doubled both times: `attack_damage` passed its gate on a `str` spell, and
  // `ailment_damage` is ungated in this fixture.
  closeTo(attack.hit, base.hit * 2);

  // The pool did not follow the attack stat — the freeze event is `int`.
  closeTo(attack.freeze.accumulated, base.freeze.accumulated);
  // And did follow the ailment stat, which is the control: the event really is being run, rather
  // than the pool being immune to everything.
  closeTo(ailment.freeze.accumulated, base.freeze.accumulated * 2);

  // `damageEffectivenessMulti` is 0.85 for freeze, which is the "85% is stored" in the tooltip.
  // It multiplies the *event's* number, not the hit's.
  closeTo(base.freeze.accumulated, base.freeze.eventDamage * 0.85);
});

/**
 * The calibration, measured in game on 2026-09-18 against Mine and Slash 6.4.13.
 *
 * One Tidal Strike on one mob, read off three damage-log hovers:
 *
 *     Spell: Tidal Strike                    Damage Over Time            Ailment Proc: Shatter
 *     Cold:                                  Ailment: Freeze             Ailment: Freeze
 *     Base Damage: 659                       Base Damage: 659            Base Damage: 988
 *       [Source]: Additive Damage: x1.82       [Source]: Additive: x1.30    (no rows)
 *       [Target]: Elemental Mitigation: x1.18  [Target]: Elem Mit: x1.18
 *       Stat: Area Damage: x1.15               Stat: Area Damage: x1.15
 *     Final Damage: 1629                     Final Damage: 1162          Final Damage: 988
 *
 * Three things fall out of those numbers, and this test is here because the local fixture that
 * also pins them is a character dump and therefore not committed:
 *
 *  - **the ailment's base is the hit's base**, 659 both times, not the hit's 1629 — the hit's
 *    own multipliers are not in it;
 *  - **the ailment's event is a different event**, x1.30 against the hit's x1.82 off the same
 *    sheet, which is the `dot`/`int` gating already pinned above;
 *  - **the pool is 85% of that event's final number**: 1162 x 0.85 = 987.7, printed 988. It is
 *    the ailment's *final* damage that gets multiplied, not its base and not the hit's.
 *
 * The Shatter block is the fourth fact and the easiest to get wrong: base 988, final 988, with
 * an empty `Damage Info:`. `EntityAilmentData` fires the pool with `calcSourceEffects =
 * calcTargetEffects = false`, so nothing applies to it a second time — an engine that swept the
 * source again here would agree with every number above and still be wrong by a whole pipeline.
 */
test("a Shatter releases 85% of the freeze event and a Shock 100% of the electrify", () => {
  const ailing = (element: string, ailment: string) =>
    engineSnapshot({
      mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
      mmorpg_spells: {
        bolt: spellEntry("bolt", element, "hit100", {
          config: { tags: { tags: [] }, use_support_gems_from: "", style: "int", cooldown_ticks: 20 },
        }),
      },
      mmorpg_stat: {
        [`${ailment}_chance`]: statEntry(`${ailment}_chance`),
        [`${ailment}_proc_chance`]: statEntry(`${ailment}_proc_chance`),
      },
      mmorpg_stat_effect: EFFECTS,
      mmorpg_stat_condition: CONDITIONS,
      mmorpg_base_stats: {
        original_mode_player: baseStats("original_mode_player", [
          exact(`${ailment}_chance`, "FLAT", 100),
          exact(`${ailment}_proc_chance`, "FLAT", 50),
        ]),
      },
    });

  const poolOf = (element: string, id: string) => {
    const doc = {
      schemaVersion: 1,
      character: { level: 1 },
      skills: [{ spellId: "bolt", main: true }],
    } as BuildDoc;
    const found = simulateHit(doc, ailing(element, id), {})!.hit.ailments.find((a) => a.ailment === id);
    assert.ok(found !== undefined, `a ${element} hit with ${id} chance inflicts ${id}`);
    return found;
  };

  // `Ailments.java:14-20` gives freeze a `damageEffectivenessMulti` of 0.85 and electrify one of
  // 1. Everything else about the two is identical, which is why one measurement calibrates both
  // — and why the pair is worth asserting together rather than freeze alone.
  const freeze = poolOf("Cold", "freeze");
  closeTo(freeze.accumulated, freeze.eventDamage * 0.85, "freeze stores 85% of its event");

  const electrify = poolOf("Nature", "electrify");
  closeTo(electrify.accumulated, electrify.eventDamage, "electrify stores all of its event");

  // Neither ticks, so `damagePerSecond` is not where the damage is — the pool is.
  assert.equal(freeze.damagePerSecond, 0);
  assert.equal(electrify.damagePerSecond, 0);
});

test("a converted element rolls its own ailment: the cold half of a physical hit can freeze", () => {
  // `AilmentChance.Effect.canActivate` ends
  //
  //     && (effect.getAttackType().isHit() || effect.getAttackType() == AttackType.bonus_dmg)
  //
  // — read out of `Mine_and_Slash-1.20.1-6.4.13.jar`, not the fork. `bonus_dmg` is what
  // `buildBonusElementEvent` stamps on a converted element, and that child runs the whole source
  // sweep, so the cold half of an 80%-converted physical hit is an ordinary cold hit as far as
  // `freeze_chance` is concerned.
  //
  // The engine ran ailments only on the root event, so a spear build converting four fifths of
  // itself to cold reported no freeze at all while the same skill's unconverted cold reading
  // reported one — which is what made it visible.
  const snapshot = engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: { strike: spellEntry("strike", "Physical", "hit100") },
    mmorpg_stat: { freeze_chance: statEntry("freeze_chance") },
    mmorpg_stat_effect: EFFECTS,
    mmorpg_stat_condition: CONDITIONS,
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("freeze_chance", "FLAT", 100),
        exact("phys_to_water", "FLAT", 80),
      ]),
    },
  });

  const freeze = simulateHit(BUILD, snapshot, {})!.hit.ailments.find((a) => a.ailment === "freeze");
  assert.ok(freeze !== undefined, "the converted cold event inflicts the cold ailment");
  assert.equal(freeze.element, "Cold");

  // Once, not once per event: the physical parent is the wrong element for freeze and rolls
  // nothing, so the child is the only source of it.
  assert.equal(
    simulateHit(BUILD, snapshot, {})!.hit.ailments.filter((a) => a.ailment === "freeze").length,
    1,
  );
});
