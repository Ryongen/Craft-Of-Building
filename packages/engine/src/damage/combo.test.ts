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
  } = {},
): Record<string, unknown> {
  const spell = spellEntry(id, "Physical", "hit100", {
    config: {
      tags: { tags: [] },
      use_support_gems_from: "",
      cooldown_ticks: 0,
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
