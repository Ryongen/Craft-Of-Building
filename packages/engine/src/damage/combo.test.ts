/**
 * How often a finisher actually fires.
 *
 * The chain is read out of the spell data rather than declared anywhere: a link is an effect the
 * spell both gates on and spends, and the step before it is whichever equipped skill hands that
 * effect out. `combo.ts` quotes the parts of the pack this is derived from; these pin the shape.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BuildDoc } from "@cte2/schema";

import {
  baseStats,
  closeTo,
  engineSnapshot,
  exact,
  spellEntry,
  statEntry,
  valueCalcEntry,
} from "../test-support.js";
import { simulateDps } from "./dps.js";

/** `cast_speed_ticks: 20` is one second of global cooldown, which keeps the sums readable. */
function comboSpell(
  id: string,
  opts: {
    needs?: string | string[];
    consumes?: string | string[];
    grants?: string | string[];
    castSpeedTicks?: number;
    cooldownTicks?: number;
  } = {},
): Record<string, unknown> {
  const spell = spellEntry(id, "Physical", "hit100", {
    config: {
      tags: { tags: [] },
      use_support_gems_from: "",
      cooldown_ticks: opts.cooldownTicks ?? 0,
      cast_speed_ticks: opts.castSpeedTicks ?? 20,
      cast_time_ticks: 0,
      times_to_cast: 1,
    },
  });

  const list = (v: string | string[] | undefined): string[] =>
    v === undefined ? [] : Array.isArray(v) ? v : [v];

  // Every gate on a part is ANDed, so a part carrying three of them is a spell that wants all
  // three charges at once — which is what the five most complex spells in the pack declare.
  const gate = list(opts.needs).map((id) => ({
    type: "caster_has_mns_effect",
    map: { exile_potion_id: id },
  }));

  // The effect acts go on a `self` part of their own, which is how the pack writes them: `zap`
  // damages from `on_cast[1]` and gives itself `alpha` from `on_cast[2]`, and `phase_dive` clears
  // all three charges from a `stack_remover` component targeting `self`. It matters because who
  // receives a grant is read off the enclosing part's selector — an `aoe: enemies` part hands the
  // effect to the mob, which is not a resource any rotation of yours can spend.
  const own: Record<string, unknown>[] = [
    ...list(opts.consumes).map((id) => ({
      type: "exile_effect",
      map: { exile_potion_id: id, potion_action: "REMOVE_STACKS", count: 1, potion_dur: 20 },
    })),
    ...list(opts.grants).map((id) => ({
      type: "exile_effect",
      map: { exile_potion_id: id, potion_action: "GIVE_STACKS", count: 1, potion_dur: 200 },
    })),
  ];

  (spell["attached"] as Record<string, unknown>)["on_cast"] = [
    {
      acts: [{ type: "damage", map: { element: "Physical", value_calculation: "hit100" } }],
      ifs: [{ type: "on_spell_cast", map: {} }, ...gate],
      targets: [{ type: "aoe", map: { radius: 3, selection_type: "RADIUS", en_predicate: "enemies" } }],
      en_preds: [],
    },
    ...(own.length === 0
      ? []
      : [{
          acts: own,
          ifs: [{ type: "on_spell_cast", map: {} }, ...gate],
          targets: [{ type: "self", map: {} }],
          en_preds: [],
        }]),
  ];
  return spell;
}

function effectEntry(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: "beneficial",
    max_stacks: 1,
    mc_stats: [],
    one_of_a_kind_id: "",
    spell_tags: { tags: [] },
    stacks_affect_stats: true,
    stats: [{ type: "FLAT", min: 1, max: 1, stat: "move_speed" }],
    tags: { tags: [] },
    ...extra,
  };
}

const REGISTRIES = {
  mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
  mmorpg_exile_effect: {
    link_a: effectEntry("link_a"),
    link_b: effectEntry("link_b"),
    stance: effectEntry("stance"),
  },
  mmorpg_spells: {
    // starter grants link_a and needs nothing; extender turns link_a into link_b; finisher
    // spends link_b.
    starter: comboSpell("starter", { grants: "link_a" }),
    extender: comboSpell("extender", { needs: "link_a", consumes: "link_a", grants: "link_b" }),
    finisher: comboSpell("finisher", { needs: "link_b", consumes: "link_b" }),
    // Gates on a stance and never spends it: a thing you stand in, not a thing handed to you.
    weapon_skill: comboSpell("weapon_skill", { needs: "stance" }),
    stance: comboSpell("stance", { grants: "stance" }),
  },
};

function dpsOf(spellIds: string[], main: string, doc: Partial<BuildDoc> = {}) {
  const snapshot = engineSnapshot(REGISTRIES);
  const build = {
    schemaVersion: 1,
    character: { level: 1 },
    skills: spellIds.map((spellId) => ({ spellId, main: spellId === main })),
    ...doc,
  } as BuildDoc;
  return simulateDps(build, snapshot, {});
}

test("a finisher is paced by its chain, not by its own cooldown", () => {
  // Each spell is one second of global cooldown, so pressing three of them is three seconds and
  // the finisher lands a third as often as its own 1s cycle suggests.
  const result = dpsOf(["starter", "extender", "finisher"], "finisher");
  assert.ok(result);

  assert.deepEqual(
    result.combo?.steps.map((s) => s.spellId),
    ["starter", "extender", "finisher"],
  );
  assert.deepEqual(
    result.combo?.steps.map((s) => s.needs),
    [[], ["link_a"], ["link_b"]],
    "a step's needs are a list: a finisher can want three resources at once",
  );
  // 1.05s a press, not 1.00: `Spell.getCastTimeTicks` clamps the cast to `times_to_cast`, so a
  // spell declaring no cast time still occupies one tick per cast before the global cooldown.
  closeTo(result.combo?.secondsPerCast, 3.15);
  closeTo(result.combo?.castsPerSecond, 1 / 3.15);
  closeTo(result.rate.cycleSeconds, 1.05, "the button itself comes back every 1.05s");
  // `dps` stays the button rate; `comboDps` is what the skill is worth played properly.
  assert.ok(result.comboDps !== undefined);
  closeTo(result.comboDps / result.dps, 1 / 3);
});

test("a gate the spell never spends is a condition, not a chain", () => {
  // `whirlwind` asks which stance you are in and never consumes one. Following that would put
  // "re-enter your stance" into the rotation every 0.75 seconds.
  const result = dpsOf(["stance", "weapon_skill"], "weapon_skill");
  assert.ok(result);
  assert.equal(result.combo, undefined);
  assert.equal(result.comboDps, undefined);
});

test("a skill with nothing to press before it has no chain", () => {
  const result = dpsOf(["starter"], "starter");
  assert.ok(result);
  assert.equal(result.combo, undefined);
});

test("a link nothing supplies is reported as a broken chain", () => {
  // The extender is not on the bar, so the finisher can never be reached. It still reports its
  // spam rate — that is what `dps` means — but the chain says why you will never see it.
  const result = dpsOf(["finisher"], "finisher");
  assert.ok(result);
  assert.deepEqual(result.combo?.broken.map((b) => b.effectId), ["link_b"]);
  assert.equal(result.combo?.secondsPerCast, undefined);
  assert.ok(
    result.diagnostics.some((d) => d.code === "combo-chain-broken"),
    "a chain you cannot complete is a warning, not a silent zero",
  );
});

test("a basic-attack link is timed from the vanilla attack speed the capture recorded", () => {
  // Nothing in the spell registry grants `combo_starter`; `proc_combo_starter` does, on a basic
  // attack. Vanilla's `1 / attack_speed * 20` ticks is the only delay with a defined value, and a
  // document without the attribute leaves the step — and the chain — unpriced.
  const registries = {
    ...REGISTRIES,
    mmorpg_spells: {
      ...REGISTRIES.mmorpg_spells,
      extender: comboSpell("extender", { needs: "link_a", consumes: "link_a", grants: "link_b" }),
    },
    mmorpg_stat: {
      proc_link_a: statEntry("proc_link_a", {
        effect: [
          {
            effects: ["give_link_a_to_source"],
            events: ["on_damage"],
            side: "Source",
            ifs: ["is_is_basic_atk_true"],
            order: "final_damage",
          },
        ],
      }),
    },
    mmorpg_stat_effect: {
      give_link_a_to_source: {
        id: "give_link_a_to_source",
        ser: "give_exile_effect",
        effect: "link_a",
        give_to: "Source",
        seconds: 6,
      },
    },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [exact("proc_link_a", "FLAT", 100)]),
    },
  };

  const run = (attackSpeed?: number) => {
    const snapshot = engineSnapshot(registries);
    const build = {
      schemaVersion: 1,
      character: {
        level: 1,
        ...(attackSpeed === undefined
          ? {}
          : { attributes: { "minecraft:generic.attack_speed": attackSpeed } }),
      },
      skills: [
        { spellId: "extender", main: false },
        { spellId: "finisher", main: true },
      ],
    } as BuildDoc;
    return simulateDps(build, snapshot, {});
  };

  const timed = run(2);
  assert.deepEqual(
    timed?.combo?.steps.map((s) => s.kind),
    ["basic-attack", "skill", "skill"],
  );
  // Half a second a swing, then 1.05s each for the extender and the finisher.
  closeTo(timed?.combo?.secondsPerCast, 2.6);

  const untimed = run();
  assert.equal(untimed?.combo?.steps[0]?.kind, "basic-attack");
  assert.equal(untimed?.combo?.secondsPerCast, undefined, "no attack speed, no rate");
  assert.equal(untimed?.comboDps, undefined);
  assert.ok(untimed?.diagnostics.some((d) => d.code === "combo-chain-untimed"));
});

// ---------------------------------------------------------------------------
// Several resources at once — the alpha/beta/gamma family
// ---------------------------------------------------------------------------

/**
 * A spell shaped like `phase_dive`: one branch per combination of the charges it spends.
 *
 * Two branches are enough to pin the thing that matters. The pack writes eight, one per point of
 * the `alpha`/`beta`/`gamma` truth table, each throwing a different `value_calculation`; what
 * decides which of them the engine prices is whether the charge is up, and what decides *that*
 * is whether the rotation delivered it.
 */
function branchSpell(id: string, charge: string): Record<string, unknown> {
  const spell = spellEntry(id, "Physical", "hit100", {
    config: {
      tags: { tags: [] },
      use_support_gems_from: "",
      cooldown_ticks: 0,
      cast_speed_ticks: 20,
      cast_time_ticks: 0,
      times_to_cast: 1,
    },
  });
  const hits = (calc: string, gate: Record<string, unknown>) => ({
    acts: [{ type: "damage", map: { element: "Physical", value_calculation: calc } }],
    ifs: [{ type: "on_spell_cast", map: {} }, gate],
    targets: [{ type: "aoe", map: { radius: 3, selection_type: "RADIUS", en_predicate: "enemies" } }],
    en_preds: [],
  });
  (spell["attached"] as Record<string, unknown>)["on_cast"] = [
    hits("hit100", { type: "caster_has_mns_effect", map: { exile_potion_id: charge, is_false: true } }),
    hits("hit1000", { type: "caster_has_mns_effect", map: { exile_potion_id: charge } }),
    {
      // The ninth, ungated part of `phase_dive`: whatever branch you took, the charges go.
      acts: [{
        type: "exile_effect",
        map: { exile_potion_id: charge, potion_action: "REMOVE_STACKS", count: 1, potion_dur: 20 },
      }],
      ifs: [{ type: "on_spell_cast", map: {} }],
      targets: [{ type: "self", map: {} }],
      en_preds: [],
    },
  ];
  return spell;
}

const CHARGES = {
  ...REGISTRIES,
  mmorpg_value_calc: {
    hit100: valueCalcEntry("hit100", { min: 100, max: 100 }),
    hit1000: valueCalcEntry("hit1000", { min: 1000, max: 1000 }),
  },
  mmorpg_exile_effect: {
    ...REGISTRIES.mmorpg_exile_effect,
    alpha: effectEntry("alpha"),
    beta: effectEntry("beta"),
    gamma: effectEntry("gamma"),
  },
  mmorpg_spells: {
    ...REGISTRIES.mmorpg_spells,
    zap: comboSpell("zap", { grants: "alpha" }),
    cold_snap: comboSpell("cold_snap", { grants: "beta" }),
    // One press for two charges, exactly as `turbo` does it.
    turbo: comboSpell("turbo", { grants: ["alpha", "beta"] }),
    // `fusion`: spends the two it needs to make the third.
    fusion: comboSpell("fusion", {
      needs: ["alpha", "beta"],
      consumes: ["alpha", "beta"],
      grants: "gamma",
    }),
    triple: comboSpell("triple", {
      needs: ["alpha", "beta", "gamma"],
      consumes: ["alpha", "beta", "gamma"],
    }),
    branchy: branchSpell("branchy", "alpha"),
  },
};

function chargeDps(spellIds: string[], main: string) {
  const snapshot = engineSnapshot(CHARGES);
  const build = {
    schemaVersion: 1,
    character: { level: 1 },
    skills: spellIds.map((spellId) => ({ spellId, main: spellId === main })),
  } as BuildDoc;
  const result = simulateDps(build, snapshot, {});
  assert.ok(result, `${main} produced no result`);
  return result;
}

test("a finisher wanting three resources is fed all three, not the first one", () => {
  // The walk this replaces followed `needed[0]` and stopped, on the stated grounds that "a spell
  // consuming two resources is not a shape this pack has". `phase_dive`, `chronobreak`,
  // `timewinder`, `pulsar_singularity_trap` and `parallel_convergence` are all that shape.
  const result = chargeDps(["triple", "zap", "cold_snap", "fusion"], "triple");
  assert.deepEqual(result.combo?.resources, ["alpha", "beta", "gamma"]);
  assert.deepEqual(result.combo?.holds, ["alpha", "beta", "gamma"], "the pass delivers all three");
  assert.deepEqual(result.combo?.broken, []);
});

test("a supplier that spends what it needs sends the pass back for more", () => {
  // `fusion` gates on `alpha` and `beta`, grants `gamma`, and takes the other two away again — so
  // a rotation that wants all three has to rebuild the two it just spent. Walking backwards from
  // the finisher cannot see that; the presses are simulated forwards for exactly this case.
  const result = chargeDps(["triple", "zap", "cold_snap", "fusion"], "triple");
  assert.deepEqual(
    result.combo?.steps.map((s) => s.spellId),
    ["zap", "cold_snap", "fusion", "zap", "cold_snap", "triple"],
    "zap and cold_snap are pressed twice: once to feed fusion, once to replace what it spent",
  );
});

test("a supplier covering two resources at once is pressed once, not twice", () => {
  // `turbo` grants `alpha` and `beta` together. Supplier choice is greedy on coverage, so it
  // beats casting the two single-charge spells — which is the answer a player would find too.
  const result = chargeDps(["triple", "zap", "cold_snap", "turbo", "fusion"], "triple");
  assert.deepEqual(
    result.combo?.steps.map((s) => s.spellId),
    ["turbo", "fusion", "turbo", "triple"],
  );
  assert.deepEqual(result.combo?.holds, ["alpha", "beta", "gamma"]);
});

test("a resource nothing supplies leaves the finisher in the table, and unreachable", () => {
  // A broken chain is not "nothing happens" — it is "here is the button, and here is why you
  // never get to press it usefully", which needs the button to still have a row.
  const result = chargeDps(["triple", "zap"], "triple");
  assert.deepEqual(
    result.combo?.steps.map((s) => s.spellId),
    ["zap", "triple"],
    "the presses that do work are kept, and the finisher keeps its row",
  );
  assert.deepEqual(result.combo?.broken.map((b) => b.effectId), ["beta"]);
  assert.equal(result.combo?.secondsPerCast, undefined, "a chain with a hole in it has no rate");
  assert.deepEqual(
    result.combo?.holds,
    ["alpha"],
    "you really can press zap and then triple; what you cannot do is get beta or gamma",
  );
});

test("the branch priced is the one the rotation reaches", () => {
  // The defect this closes: the chain was priced off one resource while the damage was computed
  // with every resource the build could *ever* produce assumed up. So the rate described one
  // rotation and the number described another, and the DPS was their quotient.
  const alone = chargeDps(["branchy"], "branchy");
  assert.deepEqual(alone.sources.map((s) => s.source.valueCalcId), ["hit100"],
    "nothing supplies alpha, so the un-charged branch is the one that fires");

  const supplied = chargeDps(["branchy", "zap"], "branchy");
  assert.deepEqual(supplied.sources.map((s) => s.source.valueCalcId), ["hit1000"],
    "zap supplies it, so the charged branch fires — and the chain that pays for it is priced");
  assert.deepEqual(supplied.combo?.steps.map((s) => s.spellId), ["zap", "branchy"]);
  assert.deepEqual(supplied.combo?.holds, ["alpha"]);
});

test("a resource is up because the pass delivers it, not because the build could", () => {
  // The distinction the pin exists for. `zap` is on the bar but disabled, so nothing presses it;
  // availability would still offer `alpha`, and the charged branch would fire for free.
  const snapshot = engineSnapshot(CHARGES);
  const build = {
    schemaVersion: 1,
    character: { level: 1 },
    skills: [
      { spellId: "branchy", main: true },
      { spellId: "zap", enabled: false },
    ],
  } as unknown as BuildDoc;
  const result = simulateDps(build, snapshot, {});
  assert.ok(result);
  assert.deepEqual(result.sources.map((s) => s.source.valueCalcId), ["hit100"]);
});

// ---------------------------------------------------------------------------
// Which charge state to play for
// ---------------------------------------------------------------------------

/**
 * `phase_dive` in miniature: one part that wants alpha and beta, one that wants all three, and
 * an ungated part that clears the lot. `top` is what the all-three part hits for, which is the
 * knob that decides whether the fusion detour pays for itself.
 */
function tieredSpell(id: string, top: string): Record<string, unknown> {
  const spell = spellEntry(id, "Physical", "hit100", {
    config: {
      tags: { tags: [] },
      use_support_gems_from: "",
      cooldown_ticks: 0,
      cast_speed_ticks: 20,
      cast_time_ticks: 0,
      times_to_cast: 1,
    },
  });
  const has = (charge: string) => ({ type: "caster_has_mns_effect", map: { exile_potion_id: charge } });
  const hits = (calc: string, charges: string[]) => ({
    acts: [{ type: "damage", map: { element: "Physical", value_calculation: calc } }],
    ifs: [{ type: "on_spell_cast", map: {} }, ...charges.map(has)],
    targets: [{ type: "aoe", map: { radius: 3, selection_type: "RADIUS", en_predicate: "enemies" } }],
    en_preds: [],
  });
  (spell["attached"] as Record<string, unknown>)["on_cast"] = [
    hits("hit100", ["alpha", "beta"]),
    hits(top, ["alpha", "beta", "gamma"]),
    {
      acts: ["alpha", "beta", "gamma"].map((charge) => ({
        type: "exile_effect",
        map: { exile_potion_id: charge, potion_action: "REMOVE_STACKS", count: 1, potion_dur: 20 },
      })),
      ifs: [{ type: "on_spell_cast", map: {} }],
      targets: [{ type: "self", map: {} }],
      en_preds: [],
    },
  ];
  return spell;
}

const TIERED = {
  ...CHARGES,
  mmorpg_value_calc: {
    ...CHARGES.mmorpg_value_calc,
    hit50: valueCalcEntry("hit50", { min: 50, max: 50 }),
  },
  mmorpg_spells: {
    ...CHARGES.mmorpg_spells,
    // All three up: 1100 over turbo, fusion, turbo, fire — four 1.05s presses. Beats 100 over two.
    rich: tieredSpell("rich", "hit1000"),
    // All three up: 150 over four presses. Stopping at turbo is 100 over two, which is more per second.
    lean: tieredSpell("lean", "hit50"),
  },
};

function tieredDps(spellIds: string[], main: string) {
  const snapshot = engineSnapshot(TIERED);
  const build = {
    schemaVersion: 1,
    character: { level: 1 },
    skills: spellIds.map((spellId) => ({ spellId, main: spellId === main })),
  } as BuildDoc;
  const result = simulateDps(build, snapshot, {});
  assert.ok(result, `${main} produced no result`);
  return result;
}

test("the full pass is kept when the charge it detours for is worth the detour", () => {
  const result = tieredDps(["rich", "turbo", "fusion"], "rich");
  assert.deepEqual(result.combo?.steps.map((s) => s.spellId), ["turbo", "fusion", "turbo", "rich"]);
  assert.deepEqual(result.combo?.holds, ["alpha", "beta", "gamma"]);
  closeTo(result.comboDps, 1100 / 4.2);
  const chosen = result.rotations?.filter((r) => r.chosen);
  assert.equal(chosen?.length, 1);
  assert.deepEqual(chosen?.[0]?.holds, ["alpha", "beta", "gamma"]);
});

test("a shorter pass wins when it lands more damage per second", () => {
  const result = tieredDps(["lean", "turbo", "fusion"], "lean");
  assert.deepEqual(result.combo?.steps.map((s) => s.spellId), ["turbo", "lean"],
    "stopping at alpha + beta skips fusion and the second turbo");
  assert.deepEqual(result.combo?.holds, ["alpha", "beta"]);
  closeTo(result.comboDps, 100 / 2.1);
  const full = result.rotations?.find((r) => r.holds.length === 3);
  closeTo(full?.dps, 150 / 4.2);
  assert.equal(full?.chosen, false);
  assert.ok(result.diagnostics.some((d) => d.code === "combo-partial-rotation"));
});

test("a partial pass stands in for a full one the bar cannot complete", () => {
  // No fusion: gamma is out of reach. The full pass is still listed, and broken, but the
  // alpha + beta pass is a real rotation and is what the figures describe.
  const result = tieredDps(["rich", "turbo"], "rich");
  assert.deepEqual(result.combo?.holds, ["alpha", "beta"]);
  assert.deepEqual(result.combo?.broken, []);
  closeTo(result.comboDps, 100 / 2.1);
  assert.ok(result.rotations?.some((r) => r.broken && !r.chosen));
});

test("a broken chain with no partial worth playing still reports the break", () => {
  const result = chargeDps(["triple", "zap"], "triple");
  assert.deepEqual(result.combo?.broken.map((b) => b.effectId), ["beta"]);
  assert.equal(result.rotations?.find((r) => r.chosen)?.broken, true);
});

// ---------------------------------------------------------------------------
// Cooldowns run while you press the rest
// ---------------------------------------------------------------------------

function cooldownDps(skills: Record<string, Record<string, unknown>>, main: string) {
  const snapshot = engineSnapshot({ ...REGISTRIES, mmorpg_spells: skills });
  const build = {
    schemaVersion: 1,
    character: { level: 1 },
    skills: Object.keys(skills).map((spellId) => ({ spellId, main: spellId === main })),
  } as BuildDoc;
  const result = simulateDps(build, snapshot, {});
  assert.ok(result, `${main} produced no result`);
  return result;
}

test("a finisher's cooldown absorbs the presses made while it recovers", () => {
  // A 3s finisher behind one 1.05s starter is a 3.05s pass: the starter is pressed during the
  // wait. Adding the two would charge the starter twice over.
  const result = cooldownDps({
    starter: comboSpell("starter", { grants: "link_a" }),
    slow: comboSpell("slow", { needs: "link_a", consumes: "link_a", cooldownTicks: 60 }),
  }, "slow");
  assert.deepEqual(result.combo?.steps.map((s) => s.spellId), ["starter", "slow"]);
  closeTo(result.combo?.secondsPerCast, result.rate.cycleSeconds, "paced by the finisher alone");
  assert.equal(result.combo?.steps.find((s) => s.spellId === "slow")?.cooldownBound, true);
});

test("a supplier pressed twice in a pass waits out its cooldown between the two", () => {
  // turbo, fusion, turbo, triple: turbo's 3s cooldown has to pass between its two presses and
  // again before the next pass comes round, so the pass is at least six seconds.
  const result = cooldownDps({
    turbo: comboSpell("turbo", { grants: ["alpha", "beta"], cooldownTicks: 60 }),
    fusion: comboSpell("fusion", { needs: ["alpha", "beta"], consumes: ["alpha", "beta"], grants: "gamma" }),
    triple: comboSpell("triple", { needs: ["alpha", "beta", "gamma"], consumes: ["alpha", "beta", "gamma"] }),
  }, "triple");
  assert.deepEqual(result.combo?.steps.map((s) => s.spellId), ["turbo", "fusion", "turbo", "triple"]);
  // Each turbo gap is one turbo press plus one other: 2.1s, raised to turbo's own cycle.
  const turboCycle = 3.05;
  closeTo(result.combo?.secondsPerCast, 2 * turboCycle);
});

// ---------------------------------------------------------------------------
// Charges the document states
// ---------------------------------------------------------------------------

test("a charge set by hand is taken as given, and the rotations say so", () => {
  // The defect: every candidate was priced with the document's gamma-on, alpha-off, beta-off,
  // while the table labelled them "alpha + beta + gamma", "alpha + beta" and so on — four rows,
  // one branch, the same DPS on each.
  const snapshot = engineSnapshot(TIERED);
  const build = {
    schemaVersion: 1,
    character: { level: 1 },
    skills: ["rich", "turbo", "fusion"].map((spellId) => ({ spellId, main: spellId === "rich" })),
    config: { effects: { alpha: false, beta: false, gamma: true } },
  } as unknown as BuildDoc;
  const result = simulateDps(build, snapshot, {});
  assert.ok(result);
  assert.deepEqual([...(result.combo?.fixed ?? [])].sort(), ["alpha", "beta", "gamma"]);
  assert.deepEqual(result.combo?.holds, ["gamma"], "labelled with the branch it is priced on");
  assert.deepEqual(result.combo?.steps.map((s) => s.spellId), ["rich"], "nothing pressed to supply it");
  // Nothing left to choose, so there is no comparison to show.
  assert.equal(result.rotations, undefined);
});

test("a charge set by hand narrows the search to the others", () => {
  const snapshot = engineSnapshot(TIERED);
  const build = {
    schemaVersion: 1,
    character: { level: 1 },
    skills: ["rich", "turbo", "fusion"].map((spellId) => ({ spellId, main: spellId === "rich" })),
    config: { effects: { gamma: true } },
  } as unknown as BuildDoc;
  const result = simulateDps(build, snapshot, {});
  assert.ok(result);
  for (const rotation of result.rotations ?? []) {
    assert.ok(rotation.holds.includes("gamma"), "every candidate holds the gamma the document states");
    assert.ok(!rotation.presses.includes("fusion"), "and none of them presses fusion to make it");
  }
  // gamma stated up: turbo, fire lands the all-three branch in two presses.
  assert.deepEqual(result.combo?.steps.map((s) => s.spellId), ["turbo", "rich"]);
  assert.deepEqual(result.combo?.holds, ["alpha", "beta", "gamma"]);
});

test("on a tie the rotation with fewer presses wins", () => {
  // Both branches hit for 100 and the finisher is paced by its own 3s cooldown, so `zap` first
  // buys nothing — the zap fits inside the wait and the damage is the same. Pressing it alone is
  // the one to play, and it leaves the global cooldown free for the rest of the bar.
  const even = branchSpell("even", "alpha");
  const parts = (even["attached"] as Record<string, unknown>)["on_cast"] as Record<string, unknown>[];
  (parts[1]!["acts"] as Record<string, unknown>[])[0]!["map"] = {
    element: "Physical",
    value_calculation: "hit100",
  };
  (even["config"] as Record<string, unknown>)["cooldown_ticks"] = 60;
  const snapshot = engineSnapshot({ ...CHARGES, mmorpg_spells: { ...CHARGES.mmorpg_spells, even } });
  const build = {
    schemaVersion: 1,
    character: { level: 1 },
    skills: ["even", "zap"].map((spellId) => ({ spellId, main: spellId === "even" })),
  } as BuildDoc;
  const result = simulateDps(build, snapshot, {});
  assert.ok(result);
  const [withZap, alone] = [
    result.rotations?.find((r) => r.holds.includes("alpha")),
    result.rotations?.find((r) => r.holds.length === 0),
  ];
  assert.ok(withZap?.dps !== undefined && alone?.dps !== undefined);
  closeTo(withZap.dps, alone.dps, "the two passes land the same damage per second");
  assert.equal(alone.chosen, true, "and the one without the extra press is kept");
});

test("a pass for one charge presses the supplier that hands over only that one", () => {
  // `turbo` first on the bar used to win every alpha request and arrive holding beta as well, so
  // "alpha only" — `parallel_convergence`'s only damaging branch — was never priced.
  const result = tieredDps(["rich", "turbo", "zap", "fusion"], "rich");
  const alphaOnly = result.rotations?.find((r) => r.holds.join() === "alpha");
  assert.ok(alphaOnly, "alpha alone is one of the rotations priced");
  assert.deepEqual(alphaOnly.presses, ["zap", "rich"]);
});

test("a resource you get by hitting yourself splits the casts between the two branches", () => {
  // `dark_pact`'s shape: a plain hit below three `sacrifice`, a big hit at three that spends
  // them, a self-hit every cast, and `sacrifice_when_hit` rolling on every hit you take. Nothing
  // on the bar grants `sacrifice`, so there is no pass to press; an aura hitting you once a
  // second and the pact's own self-hit supply 2 stacks a second against the 3 a cast spends.
  const atThree = { type: "caster_has_mns_effect", map: { exile_potion_id: "sac", effect_stacks: 3 } };
  const belowThree = { ...atThree, map: { ...atThree.map, is_false: true } };
  const enemies = [{ type: "aoe", map: { radius: 3, selection_type: "RADIUS", en_predicate: "enemies" } }];
  const self = [{ type: "self", map: {} }];
  const cast = { type: "on_spell_cast", map: {} };
  const hurtSelf = { type: "damage", map: { element: "Physical", value_calculation: "hit100", allow_self_damage: true } };

  const pact = comboSpell("pact");
  (pact["attached"] as Record<string, unknown>)["on_cast"] = [
    { acts: [{ type: "damage", map: { element: "Physical", value_calculation: "hit100" } }], ifs: [cast, belowThree], targets: enemies, en_preds: [] },
    { acts: [hurtSelf], ifs: [cast], targets: self, en_preds: [] },
    { acts: [{ type: "damage", map: { element: "Physical", value_calculation: "hit300" } }], ifs: [cast, atThree], targets: enemies, en_preds: [] },
    {
      acts: [{ type: "exile_effect", map: { exile_potion_id: "sac", potion_action: "REMOVE_STACKS", count: 3, potion_dur: 200 } }],
      ifs: [cast, atThree],
      targets: self,
      en_preds: [],
    },
  ];

  const snapshot = engineSnapshot({
    ...REGISTRIES,
    mmorpg_value_calc: {
      ...REGISTRIES.mmorpg_value_calc,
      hit300: valueCalcEntry("hit300", { min: 300, max: 300 }),
    },
    mmorpg_exile_effect: {
      sac: effectEntry("sac", { max_stacks: 5 }),
      torment: effectEntry("torment", {
        spell: {
          entity_components: {
            default_entity_name: [
              { acts: [hurtSelf], ifs: [{ type: "x_ticks_condition", map: { tick_rate: 20 } }], targets: self, en_preds: [] },
            ],
          },
          on_cast: [],
        },
      }),
    },
    mmorpg_spells: { pact, torment: comboSpell("torment", { grants: "torment" }) },
    mmorpg_stat: {
      sac_when_hit: statEntry("sac_when_hit", {
        is_perc: true,
        effect: [{ effects: ["give_sac"], events: ["on_damage"], ifs: ["random_roll"], order: "final_damage", side: "Target" }],
      }),
    },
    mmorpg_stat_effect: {
      give_sac: { id: "give_sac", ser: "give_exile_effect", effect: "sac", give_to: "Target", seconds: 10 },
    },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [exact("sac_when_hit", "FLAT", 100)]),
    },
  });
  const build = {
    schemaVersion: 1,
    character: { level: 1 },
    skills: [{ spellId: "pact", main: true }, { spellId: "torment" }],
  } as BuildDoc;

  const result = simulateDps(build, snapshot, {});
  assert.ok(result);
  const share = (valueCalcId: string): number | undefined =>
    result.sources.find((s) => s.source.valueCalcId === valueCalcId && !s.hit.selfHit)?.source.castShare;
  // One stack a second from the aura and one per cast, against three a cast spends.
  const casts = result.rate.castsPerCycle / result.rate.cycleSeconds;
  const expected = (1 + casts) / (3 * casts);
  closeTo(share("hit300")!, expected, "the gated hit lands on the casts the stacks pay for");
  closeTo(share("hit100")!, 1 - expected, "and the plain one on the rest");
  assert.ok(result.diagnostics.some((d) => d.code === "self-hit-supply"));
  assert.ok(!result.diagnostics.some((d) => d.code === "cast-requires-effect"));
  assert.ok(!result.diagnostics.some((d) => d.code === "branch-gated-off" && d.message.includes("`sac`")));
});
