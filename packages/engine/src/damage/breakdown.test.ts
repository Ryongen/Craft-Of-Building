/**
 * The damage trace.
 *
 * These check two different things and it is worth keeping them apart. That a trace *balances*
 * — every row's `after` is the next row's `before`, and the last one is the number reported —
 * is a property of the recorder, and a trace that does not balance is lying about arithmetic
 * that did happen. That a row is *attributed* to the right stat is a property of the sweep
 * setting `Recorder.statId`, and is the whole reason this exists: the game's own damage log
 * prints layer totals with no idea what fed them.
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
import { traceTotal, type EventTrace } from "./breakdown.js";
import { simulateHit } from "./simulate.js";

const CONDITIONS = {
  is_crit_true: condition("is_crit_true", "is_bool_true", { bool_id: "crit" }),
};

const EFFECTS = {
  add_additive: modifyLayer("add_additive", "additive_damage"),
  add_crit: modifyLayer("add_crit", "crit_damage"),
  add_flat: modifyLayer("add_flat", "flat_damage"),
};

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

/** Every row of a trace is continuous with the next, and the last one is what was dealt. */
function assertBalances(trace: EventTrace): void {
  let running = trace.baseNumber;
  for (const step of trace.steps) {
    closeTo(step.before, running, `layer ${step.layerId} starts where the last one ended`);
    running = step.after;
  }
  for (const more of trace.moreMultis) {
    closeTo(more.before, running, `more ${more.statId} starts where the layers ended`);
    closeTo(more.after, running * more.multi, `more ${more.statId} multiplies`);
    running = more.after;
  }
  closeTo(trace.finalNumber, Math.max(0, running), "the last row is the number dealt");
  for (const child of trace.children) assertBalances(child);
}

test("no trace is built unless one is asked for", () => {
  const plain = simulateHit(build(), scenario());
  assert.equal(plain?.hit.trace, undefined);
  assert.equal(plain?.average.trace, undefined);

  const traced = simulateHit(build(), scenario(), { breakdown: true });
  assert.ok(traced?.hit.trace);
  // The average is a blend of two totals, not a third run, so it has no rows of its own.
  assert.equal(traced.average.trace, undefined);
});

test("a trace names the stat behind every layer, which the game's own log cannot", () => {
  const snapshot = scenario(
    {
      increased_damage: damageStat("increased_damage", {
        effect: [effectBlock("before_damage_layers", ["add_additive"])],
      }),
      // Deliberately not a real stat id. `spell_damage` used to stand here and now carries an
      // in-code effect of its own (`SkillDamage`), which would add a second 20 to the same
      // accumulator and make this a test of two things at once.
      area_damage: damageStat("area_damage", {
        effect: [effectBlock("before_damage_layers", ["add_additive"])],
      }),
      flat_phys: statEntry("flat_phys", {
        effect: [effectBlock("before_damage_layers", ["add_flat"])],
      }),
    },
    [
      exact("increased_damage", "FLAT", 30),
      exact("area_damage", "FLAT", 20),
      exact("flat_phys", "FLAT", 40),
    ],
  );

  const result = simulateHit(build(), snapshot, { breakdown: true });
  const trace = result?.hit.trace;
  assert.ok(trace);

  // (100 + 40) * (1 + 50/100) = 210.
  closeTo(result.hit.total, 210);
  assertBalances(trace);

  const flat = trace.steps.find((s) => s.layerId === "flat_damage")!;
  assert.equal(flat.action, "ADD");
  closeTo(flat.amount, 40);
  assert.deepEqual(
    flat.contributions.map((c) => c.statId),
    ["flat_phys"],
  );

  const additive = trace.steps.find((s) => s.layerId === "additive_damage")!;
  assert.equal(additive.action, "MULTIPLY");
  closeTo(additive.multiplier!, 1.5);
  // Two different stats fed one accumulator. This is the split the game throws away.
  assert.deepEqual(
    additive.contributions.map((c) => ({ statId: c.statId, value: c.value })).sort((a, b) => a.statId.localeCompare(b.statId)),
    [
      { statId: "area_damage", value: 20 },
      { statId: "increased_damage", value: 30 },
    ],
  );
  assert.deepEqual(new Set(additive.contributions.map((c) => c.effectId)), new Set(["add_additive"]));
  // Layers appear in the order they applied, offence before defence.
  assert.ok(
    trace.steps.findIndex((s) => s.layerId === "flat_damage") <
      trace.steps.findIndex((s) => s.layerId === "additive_damage"),
  );
});

test("a MORE multiplier is its own row, after every layer, and names its stat", () => {
  const snapshot = scenario(
    {
      increased_damage: damageStat("increased_damage", {
        effect: [effectBlock("before_damage_layers", ["add_additive"])],
      }),
    },
    [exact("increased_damage", "FLAT", 50), exact("increased_damage", "MORE", 20)],
  );

  const result = simulateHit(build(), snapshot, { breakdown: true });
  const trace = result?.hit.trace;
  assert.ok(trace);
  closeTo(result.hit.total, 180);
  assertBalances(trace);

  assert.equal(trace.moreMultis.length, 1);
  assert.equal(trace.moreMultis[0]!.statId, "increased_damage");
  closeTo(trace.moreMultis[0]!.multi, 1.2);
  // Which block recorded it. One stat can write several `MULTIPLICATIVE_DAMAGE` blocks behind
  // different gates and the game prints one row per block, so a breakdown legitimately shows the
  // same name twice — and without this there is nothing on the row that says which is which.
  assert.equal(trace.moreMultis[0]!.effectId, "add_additive");
  // The same stat contributed to a layer *and* a multiplier, with its MORE held out of the
  // layer's value the whole way. Both rows name it, which is what makes that visible.
  closeTo(trace.steps.find((s) => s.layerId === "additive_damage")!.multiplier!, 1.5);
});

test("the crit branch traces the crit layer and the plain branch does not", () => {
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

  const result = simulateHit(build(), snapshot, { breakdown: true });
  assert.ok(result);
  assert.equal(
    result.hit.trace!.steps.find((s) => s.layerId === "crit_damage"),
    undefined,
  );
  closeTo(result.crit.trace!.steps.find((s) => s.layerId === "crit_damage")!.multiplier!, 1.5);
  assertBalances(result.hit.trace!);
  assertBalances(result.crit.trace!);
});

test("a bonus element is a nested trace, and the totals add up", () => {
  const snapshot = engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: { strike: spellEntry("strike", "Physical", "hit100") },
    mmorpg_stat: {},
    mmorpg_stat_effect: EFFECTS,
    mmorpg_stat_condition: CONDITIONS,
    mmorpg_base_stats: {
      // `phys_to_fire` is an in-code conversion effect, so it needs no datapack block.
      original_mode_player: baseStats("original_mode_player", [exact("phys_to_fire", "FLAT", 40)]),
    },
  });

  const result = simulateHit(build(), snapshot, { breakdown: true });
  const trace = result?.hit.trace;
  assert.ok(trace);
  assert.equal(trace.children.length, 1, "40% converted away spawns exactly one child event");
  assert.equal(trace.children[0]!.element, "Fire");
  assert.equal(trace.children[0]!.depth, 1);
  assertBalances(trace);
  // `Total Combined Damage` in the game's log is the sum of the tree, which is also `total`.
  closeTo(traceTotal(trace), result.hit.total);
});

test("penetration drives a resist negative, and the trace shows it amplifying", () => {
  // The question this answers: penetration is *not* floored at 0 resist. `ElementalResist.min`
  // is -300 and `getUsableValue` clamps to it, so 100 penetration against 20 resist lands at
  // -80 and the mitigation layer becomes a x1.8 multiplier rather than a reduction.
  const snapshot = engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: { strike: spellEntry("strike", "Fire", "hit100") },
    mmorpg_stat: {},
    mmorpg_stat_effect: EFFECTS,
    mmorpg_stat_condition: CONDITIONS,
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("fire_penetration", "FLAT", 100),
      ]),
    },
  });
  const doc = build({ config: { enemy: { resists: { fire: 20 } } } } as Partial<BuildDoc>);

  const result = simulateHit(doc, snapshot, { breakdown: true });
  const trace = result?.hit.trace;
  assert.ok(trace);
  closeTo(trace.penetration, 100);
  closeTo(result.hit.total, 180);

  const mitigation = trace.steps.find((s) => s.layerId === "elemental_mitigation")!;
  // `reduce(-80)` leaves the accumulator at +80, which `getMultiplier` reads as 1 + 80/100.
  closeTo(mitigation.multiplier!, 1.8);
  assert.deepEqual(
    mitigation.contributions.map((c) => ({ statId: c.statId, side: c.side })),
    [{ statId: "fire_resist", side: "Target" }],
  );
  assertBalances(trace);
});

test("penetration against a target at zero resist still spends, because the effect runs on zero", () => {
  // Version skew, and the reason the jar wins over the checkout. In 6.4.8
  // (`reference/mns-src`) `ElementalResistEffect` does not override `runsOnZeroStat`, so a
  // resist of 0 was never swept and penetration was spent on nothing. In
  // `Mine_and_Slash-1.20.1-6.4.13.jar` — the version this snapshot was extracted from — it
  // overrides it and returns `true`, the same as `ArmorEffect`. Without that, mitigation is
  // not even monotonic: 18 penetration is worth +8% damage against 10 resist and nothing at
  // all against 0.
  const snapshot = engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: { strike: spellEntry("strike", "Fire", "hit100") },
    mmorpg_stat: {},
    mmorpg_stat_effect: EFFECTS,
    mmorpg_stat_condition: CONDITIONS,
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [
        exact("fire_penetration", "FLAT", 100),
      ]),
    },
  });
  const doc = build({ config: { enemy: { resists: { fire: 0 } } } } as Partial<BuildDoc>);

  const trace = simulateHit(doc, snapshot, { breakdown: true })?.hit.trace;
  assert.ok(trace);
  const mitigation = trace.steps.find((s) => s.layerId === "elemental_mitigation");
  assert.ok(mitigation, "the layer exists even though the target's resist is 0");
  // 0 resist - 100 penetration = -100, which `reduce(-100)` turns into a x2 multiplier.
  closeTo(mitigation.multiplier!, 2);
  closeTo(trace.finalNumber, 200);
});

test("simulateHit hands back the sheets a breakdown needs to name a source", () => {
  const result = simulateHit(build(), scenario(), { breakdown: true });
  assert.ok(result);
  // The spell unit is a second, separate calculation — support gems reach it and not the
  // character sheet. Both are returned so a trace row can be resolved against either.
  assert.ok(result.sheets.character.contexts.length > 0);
  assert.ok(Array.isArray(result.sheets.spell.contexts));
});

test("a MULTIPLICATIVE_DAMAGE stat with no MORE on it emits no row", () => {
  // `EffectEvent.addMoreMulti` opens `fload_3; fconst_1; fcmpl; ifeq <return>` in the shipped
  // 6.4.13 jar — a multiplier of exactly 1 is dropped rather than recorded. Arithmetically that
  // changes nothing; what it changes is the log, which prints one `Multipliers:` row per
  // recorded MORE. 179 stats in this pack are MULTIPLICATIVE_DAMAGE, so without the guard a
  // breakdown grows a column of `x1.000` the game never shows and stops lining up with the
  // hover it exists to be compared against.
  const snapshot = scenario(
    {
      increased_damage: damageStat("increased_damage", {
        effect: [effectBlock("before_damage_layers", ["add_additive"])],
      }),
    },
    [exact("increased_damage", "FLAT", 50)],
  );

  const result = simulateHit(build(), snapshot, { breakdown: true });
  const trace = result?.hit.trace;
  assert.ok(trace);
  closeTo(result.hit.total, 150);
  assertBalances(trace);

  assert.deepEqual(trace.moreMultis, [], "it fed the layer, and that is the only row it earns");
  closeTo(trace.steps.find((s) => s.layerId === "additive_damage")!.multiplier!, 1.5);
});
