/**
 * The damage event end to end.
 *
 * Built on synthetic snapshots so each case isolates one behaviour. The cases that earn their
 * keep are the ordering ones — a pipeline that applies the right arithmetic in the wrong order
 * produces plausible numbers, which is the failure mode hardest to notice.
 *
 * Note how stats get onto the sheet: a stat with a `base` but nothing contributing to it is
 * never in the container at all, because `InCalcStatContainer.calculate()` only resolves stats
 * in flight. That is the game's behaviour too, and it is why every case here grants its stats
 * through `original_mode_player` rather than relying on a declared base.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BuildDoc } from "@cte2/schema";

import {
  baseStats,
  closeTo,
  condition,
  damageStat,
  effectBlock,
  engineSnapshot,
  exact,
  modifyLayer,
  spellEntry,
  statEntry,
  valueCalcEntry,
} from "../test-support.js";
import type { AilmentResult } from "./ailments.js";
import { simulateHit, type HitOutcome } from "./simulate.js";

const CONDITIONS = {
  is_crit_true: condition("is_crit_true", "is_bool_true", { bool_id: "crit" }),
  is_resisted_already_true: condition("is_resisted_already_true", "is_bool_true", {
    bool_id: "resisted_already",
  }),
  random_roll: condition("random_roll", "random_roll"),
  is_daytime: condition("is_daytime", "is_day"),
  // The pack's own thresholds, with its own ids: an execute at half health, an opener above
  // seventy percent, and a low-life bonus on the caster.
  is_target_low_hp: condition("is_target_low_hp", "is_hp_under", { perc: 50, side: "Target" }),
  is_target_near_full_hp: condition("is_target_near_full_hp", "is_hp_above", {
    perc: 70,
    side: "Target",
  }),
  is_source_low_hp: condition("is_source_low_hp", "is_hp_under", { perc: 50, side: "Source" }),
};

const EFFECTS = {
  add_additive: modifyLayer("add_additive", "additive_damage"),
  add_crit: modifyLayer("add_crit", "crit_damage"),
  add_double: modifyLayer("add_double", "double_damage"),
  add_flat: modifyLayer("add_flat", "flat_damage"),
};

/**
 * A physical spell dealing a flat 100, plus the stats a case needs.
 *
 * `granted` is applied through the player's base stats, which is the shortest route to putting
 * a value on the sheet without dragging gear legality into a damage test.
 */
function scenario(
  stats: Record<string, Record<string, unknown>> = {},
  granted: Record<string, unknown>[] = [],
) {
  return engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: { strike: spellEntry("strike", "Physical", "hit100") },
    mmorpg_stat: stats,
    mmorpg_stat_effect: EFFECTS,
    mmorpg_stat_condition: CONDITIONS,
    mmorpg_base_stats: { original_mode_player: baseStats("original_mode_player", granted) },
  });
}

function build(extra: Partial<BuildDoc> = {}): BuildDoc {
  return {
    schemaVersion: 1,
    character: { level: 1 },
    skills: [{ spellId: "strike", main: true }],
    ...extra,
  } as BuildDoc;
}

test("a bare hit is the value calc's number, untouched", () => {
  const result = simulateHit(build(), scenario());
  assert.ok(result);
  assert.equal(result.baseValue, 100);
  assert.equal(result.hit.total, 100);
  assert.equal(result.element, "Physical");
});

test("an additive_damage stat multiplies, and its MORE rides separately as dmgMulti", () => {
  // `increased_damage` is MULTIPLICATIVE_DAMAGE, so its MORE modifiers stay out of the value
  // through the whole stat calculation and arrive here as `StatData.m`. The layer gets the
  // value; the more-multi applies after every layer, which is the entire reason phase 1 kept
  // the two numbers apart.
  const snapshot = scenario(
    {
      increased_damage: damageStat("increased_damage", {
        effect: [effectBlock("before_damage_layers", ["add_additive"])],
      }),
    },
    [exact("increased_damage", "FLAT", 50), exact("increased_damage", "MORE", 20)],
  );

  const result = simulateHit(build(), snapshot);
  assert.ok(result);
  // value 50 -> additive layer x1.5; MORE 20% -> dmgMulti 1.2, applied last. 100*1.5*1.2 = 180.
  closeTo(result.hit.total, 180);
});

test("a stat with no value but a dmgMulti still runs its effects", () => {
  // `EffectEvent.calculateEffects` gates on `StatData.isNotZero()`, which is
  // `v1 != 0 || this.m != 1` — **two** clauses. A `MULTIPLICATIVE_DAMAGE` stat keeps everything
  // it has in `m` and leaves `v1` at zero, so checking the value alone drops it entirely. The
  // pack has real ones: `all_fire_damage` reaches 1.40 on the reference build and was worth a
  // quarter of the damage against a fire skill, missing, with nothing on screen to say so.
  const snapshot = scenario(
    {
      increased_damage: damageStat("increased_damage", {
        effect: [effectBlock("before_damage_layers", ["add_additive"])],
      }),
    },
    // MORE only: the value stays 0 and `dmgMulti` becomes 1.2.
    [exact("increased_damage", "MORE", 20)],
  );

  const result = simulateHit(build(), snapshot);
  assert.ok(result);
  // The additive layer adds 0, and the more-multi applies after every layer: 100 * 1.2.
  closeTo(result.hit.total, 120);
});

test("crit is branched, not averaged", () => {
  const snapshot = scenario(
    {
      critical_hit: statEntry("critical_hit", { max: 100 }),
      critical_damage: statEntry("critical_damage", {
        is_perc: true,
        effect: [effectBlock("damage_layers", ["add_crit"], ["is_crit_true"])],
      }),
    },
    [exact("critical_hit", "FLAT", 25), exact("critical_damage", "FLAT", 50)],
  );

  const result = simulateHit(build(), snapshot);
  assert.ok(result);
  assert.equal(result.critChance, 0.25);
  assert.equal(result.hit.total, 100, "the non-crit branch must not see the crit layer");
  closeTo(result.crit.total, 150, "the crit branch applies 1 + 50/100");
  // The average is the mean of two numbers the game can actually produce, not a third one.
  closeTo(result.average.total, 100 * 0.75 + 150 * 0.25);
});

test("the average branch weights every ailment number, not just the per-second one", () => {
  // A crit-gated `flat_damage` stat is what makes the two branches' ailments differ: the
  // ailment's base is `originalNumber + appliedFlatDamage`, so the crit branch bleeds harder.
  const snapshot = scenario(
    {
      critical_hit: statEntry("critical_hit", { max: 100 }),
      crit_flat: statEntry("crit_flat", {
        effect: [effectBlock("before_damage_layers", ["add_flat"], ["is_crit_true"])],
      }),
      bleed_chance: statEntry("bleed_chance", { is_perc: true, max: 100 }),
    },
    [
      exact("critical_hit", "FLAT", 25),
      exact("crit_flat", "FLAT", 100),
      exact("bleed_chance", "FLAT", 30),
    ],
  );

  const result = simulateHit(build(), snapshot);
  assert.ok(result);

  const on = (outcome: HitOutcome): AilmentResult | undefined =>
    outcome.ailments.find((a) => a.ailment === "bleed");
  const hit = on(result.hit);
  const crit = on(result.crit);
  const average = on(result.average);
  assert.ok(hit && crit && average);

  // The premise: the crit branch's bleed is bigger, so a positional carry would be visible.
  assert.ok(crit.totalDamage > hit.totalDamage * 1.5);

  closeTo(average.damagePerSecond, hit.damagePerSecond * 0.75 + crit.damagePerSecond * 0.25);
  closeTo(average.totalDamage, hit.totalDamage * 0.75 + crit.totalDamage * 0.25);
  // And the three numbers the Damage tab prints on one line still multiply out.
  closeTo(average.damagePerSecond * average.durationSeconds, average.totalDamage);
});

test("a datapack damage_layers stat ties with the in-code resist, and the tie is broken by id", () => {
  // This used to assert that a datapack `order: "damage_layers"` ran *after* the in-code
  // resist. That was true of 6.4.8, where `AFTER_DAMAGE_LAYERS` was declared with the id string
  // "DAMAGE_LAYERS" and overwrote its predecessor in the shared map, so the datapack id
  // resolved to 21 while the in-code effect kept 20.
  //
  // 6.4.13 registers three distinct ids (checked by `javap` on the shipped jar — see
  // `priority.ts`), so both are 20 and they **tie**. The game breaks that tie by `HashMap`
  // iteration order, which is to say it does not define one. This engine sorts ties by stat id,
  // a choice `sweep` already documents, and that is what this pins: deterministic, and stated
  // rather than relied upon.
  //
  // Nothing in Craft to Exile 2 can observe it. No condition in the pack reads a flag an
  // in-code effect sets at 20, so all 225 of its `damage_layers` blocks are order-independent
  // against the resist — which is why correcting the number moved no figure anywhere.
  const at = (statId: string) => {
    const snapshot = scenario(
      {
        physical_resist: statEntry("physical_resist", { min: -300, max: 500, is_perc: true }),
        [statId]: statEntry(statId, {
          effect: [effectBlock("damage_layers", ["add_additive"], ["is_resisted_already_true"])],
        }),
      },
      [exact(statId, "FLAT", 100)],
    );
    const result = simulateHit(
      build({ config: { enemy: { resists: { physical: 50 } } } }),
      snapshot,
    );
    assert.ok(result);
    return result.hit.total;
  };

  // "a_resist" sorts before "physical_resist": it runs first, sees no flag, adds nothing.
  //   100 * 0.5 = 50
  closeTo(at("a_resist"), 50);

  // "z_resist" sorts after: it sees the flag and doubles.
  //   100 * 2 * 0.5 = 100
  closeTo(at("z_resist"), 100);
});

test("a chance-gated stat contributes at its probability and says so", () => {
  const snapshot = scenario(
    {
      lucky_damage: statEntry("lucky_damage", {
        effect: [effectBlock("before_damage_layers", ["add_additive"], ["random_roll"])],
      }),
    },
    [exact("lucky_damage", "FLAT", 40)],
  );

  const result = simulateHit(build(), snapshot);
  assert.ok(result);
  // `random_roll` reads its chance from the stat's own value: 40 -> 40%, contributing 40 * 0.4.
  closeTo(result.hit.total, 116);
  assert.ok(
    result.diagnostics.some((d) => d.code === "chance-averaged"),
    "an applied probability must be named, never silent",
  );
});

test("averaging a pinned layer is flagged as inexact", () => {
  // `double_damage` clamps to exactly 2x, so scaling the contribution by a probability cannot
  // reproduce the expectation. The engine still produces a number; it must say the number is
  // an approximation rather than let it pass as the answer.
  const snapshot = scenario(
    {
      double_chance: statEntry("double_chance", {
        effect: [effectBlock("before_damage_layers", ["add_double"], ["random_roll"])],
      }),
    },
    [exact("double_chance", "FLAT", 10)],
  );

  const result = simulateHit(build(), snapshot);
  assert.ok(result);
  assert.ok(result.diagnostics.some((d) => d.code === "chance-averaging-inexact"));
});

test("a condition the document cannot answer is reported, not assumed", () => {
  const snapshot = scenario(
    {
      daytime_damage: statEntry("daytime_damage", {
        effect: [effectBlock("before_damage_layers", ["add_additive"], ["is_daytime"])],
      }),
    },
    [exact("daytime_damage", "FLAT", 100)],
  );

  const result = simulateHit(build(), snapshot);
  assert.ok(result);
  assert.equal(result.hit.total, 100, "an unanswerable condition contributes nothing");
  const reported = result.diagnostics.find((d) => d.code === "condition-not-derivable");
  assert.ok(reported, "and must be named so the omission is visible");
  assert.match(reported.message, /is_daytime/);
});

test("config.conditions forces a condition outright", () => {
  const snapshot = scenario(
    {
      daytime_damage: statEntry("daytime_damage", {
        effect: [effectBlock("before_damage_layers", ["add_additive"], ["is_daytime"])],
      }),
    },
    [exact("daytime_damage", "FLAT", 100)],
  );

  const result = simulateHit(build({ config: { conditions: { is_daytime: true } } }), snapshot);
  assert.ok(result);
  closeTo(result.hit.total, 200);
  assert.ok(!result.diagnostics.some((d) => d.code === "condition-not-derivable"));
});

test("flat_damage applies before the multipliers", () => {
  // Layer priority 0. A flat add is multiplied by everything after it, which is why the order
  // of the layer list matters as much as the order of the stat sweep.
  const snapshot = scenario(
    {
      added_damage: statEntry("added_damage", {
        effect: [effectBlock("before_damage_layers", ["add_flat"])],
      }),
      increased_damage: statEntry("increased_damage", {
        is_perc: true,
        effect: [effectBlock("before_damage_layers", ["add_additive"])],
      }),
    },
    [exact("added_damage", "FLAT", 50), exact("increased_damage", "FLAT", 100)],
  );

  const result = simulateHit(build(), snapshot);
  assert.ok(result);
  closeTo(result.hit.total, 300, "(100 + 50) * 2, not 100 * 2 + 50");
});

test("armour mitigates, and enough penetration turns it into a bonus", () => {
  const snapshot = scenario(
    {
      armor: statEntry("armor", { min: 0, scaling: "NORMAL" }),
      armor_penetration: statEntry("armor_penetration", { min: 0 }),
    },
    [],
  );

  const mitigated = simulateHit(build({ config: { enemy: { armor: 100 } } }), snapshot);
  assert.ok(mitigated);
  // At level 1 the curve base is 100, so 100 armour is 100/(100+100) = 50% mitigation.
  closeTo(mitigated.hit.total, 50);

  // `ArmorEffect.runsOnZeroStat()` is true and its defense term is signed by whether
  // armour-after-penetration went negative, so penetration against no armour *raises* damage.
  const withPen = scenario(
    {
      armor: statEntry("armor", { min: 0, scaling: "NORMAL" }),
      armor_penetration: statEntry("armor_penetration", { min: 0 }),
    },
    [exact("armor_penetration", "FLAT", 100)],
  );
  const boosted = simulateHit(build({ config: { enemy: { armor: 0 } } }), withPen);
  assert.ok(boosted);
  closeTo(boosted.hit.total, 150);
});

test("resists cap at 75 plus the max-resist stat, not at the stat's own max", () => {
  const snapshot = scenario({
    physical_resist: statEntry("physical_resist", { min: -300, max: 500, is_perc: true }),
    max_physical_resist: statEntry("max_physical_resist", { min: -100, max: 15, is_perc: true }),
  });

  const capped = simulateHit(build({ config: { enemy: { resists: { physical: 200 } } } }), snapshot);
  assert.ok(capped);
  closeTo(capped.hit.total, 25, "200% resist is clamped to 75%");

  const raised = simulateHit(
    build({ config: { enemy: { resists: { physical: 200 }, maxResists: { physical: 15 } } } }),
    snapshot,
  );
  assert.ok(raised);
  closeTo(raised.hit.total, 10, "max resist lifts the ceiling to 90%");
});

test("a fractional max resist gives a fractional ceiling, but a resist under it truncates", () => {
  // `ElementalResistEffect.activate` casts the resist to an `int` before the clamp
  // (`f2i` in the 6.4.13 jar) but `ElementalResist.getUsableValue` computes its ceiling as
  // `clamp(75 + getAdditionalMax(unit), min, 90)` in floats, and `getAdditionalMax` is just
  // `MaxElementalResist`'s sheet value. So the `(int)` only ever reaches the resist itself:
  // overcap and the clamp hands back the float ceiling untouched.
  const snapshot = scenario({
    physical_resist: statEntry("physical_resist", { min: -300, max: 500, is_perc: true }),
    max_physical_resist: statEntry("max_physical_resist", { min: -100, max: 15, is_perc: true }),
  });

  const over = simulateHit(
    build({ config: { enemy: { resists: { physical: 200 }, maxResists: { physical: 5.5 } } } }),
    snapshot,
  );
  assert.ok(over);
  closeTo(over.hit.total, 19.5, "overcapped, so the ceiling of 80.5% applies in full");

  const under = simulateHit(
    build({ config: { enemy: { resists: { physical: 40.9 }, maxResists: { physical: 5.5 } } } }),
    snapshot,
  );
  assert.ok(under);
  closeTo(under.hit.total, 60, "under the ceiling, so the (int) cast takes 40.9 to 40");
});

test("penetration applies against a target with no resist declared", () => {
  // `ElementalResistEffect.runsOnZeroStat()` returns true in 6.4.13, so an undeclared resist is
  // a resist of 0 that penetration still eats into — not a stat the sweep skips. The enemy
  // sheet seeds every resist at 0 for the same reason the game's `Unit` holds every stat.
  const snapshot = scenario(
    {
      fire_resist: statEntry("fire_resist", { min: -300, max: 500, is_perc: true }),
      fire_penetration: statEntry("fire_penetration", { min: 0 }),
    },
    [exact("fire_penetration", "FLAT", 50)],
  );

  const result = simulateHit(build({ config: { enemy: {} } }), snapshot, { element: "Fire" });
  assert.ok(result);
  // 0 resist - 50 penetration = -50, which `reduce(-50)` reads as a 1.5x multiplier.
  closeTo(result.hit.total, 150);
});

test("a build with no skill reports rather than returning a number", () => {
  assert.equal(simulateHit(build({ skills: [] }), scenario()), undefined);
});

test("the character sheet is unchanged when no skill is supplied", () => {
  // The regression gate: phase 2 must not move a phase 1 number.
  const snapshot = scenario({}, [exact("health", "FLAT", 100)]);
  const doc = build();
  const withSkill = simulateHit(doc, snapshot);
  assert.ok(withSkill);
  // Support gems and innate spell stats are the only difference, and `strike` has neither.
  assert.equal(withSkill.hit.total, 100);
});

// ---------------------------------------------------------------------------
// The health scenario
// ---------------------------------------------------------------------------

/** A hit whose damage doubles while the named condition holds. */
function gatedOn(conditionId: string) {
  return scenario(
    {
      gated_damage: statEntry("gated_damage", {
        effect: [effectBlock("before_damage_layers", ["add_additive"], [conditionId])],
      }),
    },
    [exact("gated_damage", "FLAT", 100)],
  );
}

test("a stated target health answers every threshold at once, and consistently", () => {
  // The point of stating a fraction rather than toggling each condition: 20% health cannot also
  // be "near full", so the execute pays and the opener does not. Toggled one at a time, a
  // document could claim both and collect both.
  const low = { config: { targetHealthPercent: 20 } };
  const execute = simulateHit(build(low), gatedOn("is_target_low_hp"));
  const opener = simulateHit(build(low), gatedOn("is_target_near_full_hp"));
  assert.ok(execute && opener);
  closeTo(execute.hit.total, 200, "under 50% \u2014 the execute bonus applies");
  assert.equal(opener.hit.total, 100, "and the above-70% bonus cannot apply to the same mob");

  const full = { config: { targetHealthPercent: 100 } };
  const execute2 = simulateHit(build(full), gatedOn("is_target_low_hp"));
  const opener2 = simulateHit(build(full), gatedOn("is_target_near_full_hp"));
  assert.ok(execute2 && opener2);
  assert.equal(execute2.hit.total, 100);
  closeTo(opener2.hit.total, 200);
});

test("both health comparisons are strict, so the threshold itself satisfies neither", () => {
  // `perc > hp%` and `perc < hp%` — IsHealthBellow/AbovePercentCondition. 50 is the threshold
  // seven of this pack's nine health conditions use, and a round number is what somebody types.
  const at = { config: { targetHealthPercent: 50 } };
  const under = simulateHit(build(at), gatedOn("is_target_low_hp"));
  assert.ok(under);
  assert.equal(under.hit.total, 100);
});

test("the two sides are stated separately", () => {
  // `side` on the condition picks which fraction answers it. A mob at death's door says nothing
  // about the character swinging at it.
  const snapshot = gatedOn("is_source_low_hp");
  const enemyLow = simulateHit(build({ config: { targetHealthPercent: 10 } }), snapshot);
  assert.ok(enemyLow);
  assert.equal(enemyLow.hit.total, 100, "the target's health does not answer a Source condition");

  const youLow = simulateHit(build({ config: { selfHealthPercent: 10 } }), snapshot);
  assert.ok(youLow);
  closeTo(youLow.hit.total, 200);
});

test("unstated health stays unanswerable and is reported, rather than assumed full", () => {
  // The standing rule about silent defaults. Assuming a full-health target would switch every
  // low-life bonus in the pack off without a word.
  const result = simulateHit(build(), gatedOn("is_target_low_hp"));
  assert.ok(result);
  assert.equal(result.hit.total, 100);
  const reported = result.diagnostics.find((d) => d.code === "condition-not-derivable");
  assert.ok(reported);
  assert.match(reported.message, /targetHealthPercent/);
});
