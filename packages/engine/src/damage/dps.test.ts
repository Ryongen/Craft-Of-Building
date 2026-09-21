/**
 * The rate, and the one decision in it.
 *
 * Everything here is portable from the mod and pinned to a quoted call site. What a cast
 * *produces* is checked in `skill-model.test.ts`, and how much of it reaches a target in
 * `geometry.test.ts`; this file is the rate and the cost around them.
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
import { damageWithin, simulateDps, simulateFullDps, timeToKill } from "./dps.js";

/** The three `on_spell_stat_calc` serializers a rate depends on. */
const EFFECTS = {
  decrease_cast_ticks_num: { id: "decrease_cast_ticks_num", ser: "decrease_num", num_id: "cast_ticks" },
  decrease_cd_ticks_num: { id: "decrease_cd_ticks_num", ser: "decrease_num", num_id: "cd_ticks" },
  apply_cd_as_cast_time: { id: "apply_cd_as_cast_time", ser: "apply_cd_as_cast_time" },
  proj_count: {
    id: "proj_count",
    ser: "add_to_number",
    number_id: "bonus_proj",
    num_provider: { type: "STAT_DATA", calc: "" },
  },
  // 6.4.13: the number every `*_cast_time` stat and `skill_speed` writes.
  add_cast_speed_perc: {
    id: "add_cast_speed_perc",
    ser: "add_to_number",
    number_id: "cast_speed_perc",
    num_provider: { type: "STAT_DATA", calc: "" },
  },
};

const CONDITIONS = {
  // `spell_has_tag` takes an object, not a bare string — the pack ships both shapes and they
  // are not interchangeable.
  spell_has_tag_projectile: condition("spell_has_tag_projectile", "spell_has_tag", {
    tag: { id: "projectile" },
  }),
};

function scenario({
  spellConfig = {},
  stats = {},
  granted = [],
  acts,
}: {
  spellConfig?: Record<string, unknown>;
  stats?: Record<string, Record<string, unknown>>;
  granted?: Record<string, unknown>[];
  acts?: Record<string, unknown>;
} = {}) {
  const spell = spellEntry("strike", "Physical", "hit100", {
    config: { tags: { tags: [] }, use_support_gems_from: "", cooldown_ticks: 20, ...spellConfig },
  });
  if (acts !== undefined) {
    (spell["attached"] as Record<string, unknown>)["on_cast"] = [
      {
        acts: [{ type: "damage", map: { element: "Physical", value_calculation: "hit100" } }, acts],
        ifs: [],
        targets: [{ type: "aoe", map: { radius: 3, selection_type: "RADIUS", en_predicate: "enemies" } }],
        en_preds: [],
      },
    ];
  }
  return engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: { strike: spell },
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

test("a cycle is the cast plus the cooldown, because the cooldown starts after the cast", () => {
  const result = simulateDps(build(), scenario({ spellConfig: { cast_time_ticks: 20, cooldown_ticks: 40 } }));
  assert.ok(result);
  // 20 + 40 = 60 ticks = 3s. Overlapping them would give 2s and a 50% higher DPS.
  closeTo(result.rate.cycleSeconds, 3);
  closeTo(result.rate.castSeconds, 1);
  closeTo(result.rate.cooldownSeconds, 2);
  closeTo(result.dps, 100 / 3);
});

test("a held channel repeats every cast time, and pays no cooldown between pulses", () => {
  // `SpellCastingData.onTimePass` runs `tryChannelPulse` when `castTickLeft` hits zero, and that
  // method casts and immediately re-arms `castTickLeft = getCastTimeTicks(ctx)`. It never goes
  // through `tryCast` or `onSpellCastFinished`, so nothing sets a cooldown and nothing arms the
  // shared global cooldown while the key is held.
  const result = simulateDps(
    build(),
    scenario({
      // Both, the way every one of the pack's ten player channels is authored: the flag is what
      // `config.isChannel()` reads to pulse, the tag is what gates `channel_speed_perc`.
      spellConfig: {
        cast_time_ticks: 6,
        cooldown_ticks: 60,
        cast_speed_ticks: 20,
        channel_skill: true,
        tags: { tags: ["channel"] },
      },
    }),
  );
  assert.ok(result);
  assert.equal(result.rate.channelled, true);
  closeTo(result.rate.cycleSeconds, 0.3);
  closeTo(result.rate.cooldownSeconds, 0);
  closeTo(result.rate.globalCooldownSeconds, 0);
  // Casting and recovering would have been 6 + max(60, 20) = 66 ticks, eleven times slower.
  closeTo(result.dps, 100 / 0.3);
});

test("times_to_cast fires during the cast, and floors the cast time", () => {
  const result = simulateDps(
    build(),
    scenario({ spellConfig: { cast_time_ticks: 0, cooldown_ticks: 20, times_to_cast: 5 } }),
  );
  assert.ok(result);
  // `Spell.getCastTimeTicks` clamps to `times_to_cast` at the bottom: five casts need five
  // ticks. So the cycle is 5 + 20 = 25 ticks, not 20.
  assert.equal(result.calc.castTicks, 5);
  closeTo(result.rate.cycleSeconds, 1.25);
  assert.equal(result.rate.castsPerCycle, 5);
  closeTo(result.dps, (100 * 5) / 1.25);
});

test("cooldown reduction is additive off the declared cooldown, not compounding", () => {
  const snapshot = scenario({
    spellConfig: { cooldown_ticks: 100 },
    stats: {
      cdr: statEntry("cdr", {
        is_perc: true,
        max: 75,
        effect: [effectBlock("data_modification", ["decrease_cd_ticks_num"], [], "Source", ["on_spell_stat_calc"])],
      }),
    },
    granted: [exact("cdr", "FLAT", 40)],
  });

  const result = simulateDps(build(), snapshot);
  assert.ok(result);
  // 100 - 100*40/100 = 60. A compounding reading would give the same answer for one source,
  // which is why the floor below is the interesting half of this behaviour.
  assert.equal(result.calc.cooldownTicks, 60);
});

test("cooldown cannot fall below MIN_SPELL_COOLDOWN_MULTI of the declared value", () => {
  const snapshot = scenario({
    spellConfig: { cooldown_ticks: 100 },
    stats: {
      cdr: statEntry("cdr", {
        is_perc: true,
        max: 100,
        effect: [effectBlock("data_modification", ["decrease_cd_ticks_num"], [], "Source", ["on_spell_stat_calc"])],
      }),
    },
    granted: [exact("cdr", "FLAT", 95)],
  });

  const result = simulateDps(build(), snapshot);
  assert.ok(result);
  // 95% off would be 5 ticks; the clamp holds it at 100 * 0.2.
  assert.equal(result.calc.cooldownTicks, 20);
});

test("cast speed reduces the cooldown when the spell carries cast_speed_to_cooldown", () => {
  // This is why `apply_cd_as_cast_time` could not stay a no-op: `fireball` carries the tag, so
  // for it cast speed is cooldown reduction and touching cast time does nothing at all.
  const snapshot = scenario({
    spellConfig: { cast_time_ticks: 20, cooldown_ticks: 40 },
    stats: {
      cast_speed: statEntry("cast_speed", {
        is_perc: true,
        max: 90,
        effect: [effectBlock("data_modification", ["apply_cd_as_cast_time"], [], "Source", ["on_spell_stat_calc"])],
      }),
    },
    granted: [exact("cast_speed", "FLAT", 50)],
  });

  const result = simulateDps(build(), snapshot);
  assert.ok(result);
  assert.equal(result.calc.castTicks, 20, "cast time is untouched by this effect");
  assert.equal(result.calc.cooldownTicks, 20, "40 - 40*50/100");
});

test("a projectile's damage is counted per projectile, not once per cast", () => {
  const snapshot = scenario({
    spellConfig: { tags: { tags: ["projectile"] }, cooldown_ticks: 20 },
    acts: { type: "projectile", map: { proj_count: 3 } },
    stats: {
      projectile_count: statEntry("projectile_count", {
        effect: [
          effectBlock("data_modification", ["proj_count"], ["spell_has_tag_projectile"], "Source", ["on_spell_stat_calc"]),
        ],
      }),
    },
    granted: [exact("projectile_count", "FLAT", 2)],
  });

  const result = simulateDps(build(), snapshot);
  assert.ok(result);
  assert.equal(result.multiHit.baseProjectiles, 3);
  assert.equal(result.multiHit.bonusProjectiles, 2);
  assert.equal(result.multiHit.projectiles, 5);

  // The `damage` act here sits on `on_cast` beside the `projectile` act rather than on the
  // projectile's own component group, so it resolves once against the caster no matter how
  // many projectiles are thrown. Counting it five times would be the old bug in reverse.
  const direct = result.sources.find((s) => s.source.carrier.kind === "direct");
  assert.ok(direct, "the on_cast damage act is a direct source");
  assert.equal(direct.source.instancesPerCast, 1);
});

test("a charge spell is paced by charge regeneration, not by its overwritten cooldown", () => {
  // `setChargesAndRegen` force-sets `cooldown_ticks = 3` for every charge spell, so reading the
  // cooldown would make every one of them look like a 3-tick machine gun.
  const result = simulateDps(
    build(),
    scenario({ spellConfig: { cooldown_ticks: 3, charges: 3, charge_regen: 60 } }),
  );
  assert.ok(result);
  assert.ok(result.rate.chargeBased);
  // 60 ticks of charge regen plus the one tick every cast occupies — `getCastTimeTicks`
  // clamps to `times_to_cast`, so even an "instant" spell is never zero ticks long.
  closeTo(result.rate.cycleSeconds, 3.05);
});

test("the global cooldown floors a spell with no cooldown of its own", () => {
  const result = simulateDps(build(), scenario({ spellConfig: { cast_time_ticks: 0, cooldown_ticks: 0 } }));
  assert.ok(result);
  // `min(GLOBAL_COOLDOWN_TICKS, spellCooldown)` is 0 here, so nothing floors it and the cycle
  // would be 0 seconds. Guarding that is what stops DPS becoming Infinity.
  assert.ok(Number.isFinite(result.dps));
});

test("resource cost is per cast and per second, and says whether it sustains", () => {
  const snapshot = scenario({ spellConfig: { cooldown_ticks: 20, mana_cost: { min: 10, max: 10 } } });
  const result = simulateDps(build({ character: { level: 1 } } as Partial<BuildDoc>), snapshot);
  assert.ok(result);
  closeTo(result.cost.manaPerCast, 10);
  // 20 ticks of cooldown plus the one-tick cast floor is 21 ticks, so 20/21 casts a second.
  closeTo(result.cost.manaPerSecond, 10 * (20 / 21));
  assert.equal(result.cost.sustainable, false, "no regen was granted");
});

test("the projectile count reported is the one carrying the damage, not the first thrown", () => {
  // `raging_dragon`'s shape, and a trap worth pinning. It throws a `combo_remover` projectile
  // first — a 1-tick marker with `ignore_bonus_proj: true` that deals no damage and exists only
  // to strip a buff stack — and only then the nine dragons. Reporting the first projectile the
  // walk reaches shows "1 projectile" for a spell that just threw nine.
  const spell = spellEntry("strike", "Physical", "hit100", {
    config: { tags: { tags: ["projectile"] }, use_support_gems_from: "", cooldown_ticks: 20 },
  });
  (spell["attached"] as Record<string, unknown>) = {
    entity_components: {
      dragon: [
        {
          acts: [{ type: "damage", map: { element: "Physical", value_calculation: "hit100" } }],
          ifs: [{ type: "x_ticks_condition", map: { tick_rate: 10 } }],
          targets: [{ type: "aoe", map: { radius: 3, selection_type: "RADIUS", en_predicate: "enemies" } }],
          en_preds: [],
        },
      ],
    },
    on_cast: [
      {
        acts: [
          {
            type: "projectile",
            map: { entity_name: "marker", proj_count: 1, life_ticks: 1, proj_speed: 0, ignore_bonus_proj: true },
          },
        ],
        ifs: [{ type: "on_spell_cast", map: {} }],
        targets: [],
        en_preds: [],
      },
      {
        acts: [
          {
            type: "projectile",
            map: { entity_name: "dragon", proj_count: 1, life_ticks: 20, proj_speed: 0 },
          },
        ],
        ifs: [{ type: "on_spell_cast", map: {} }],
        targets: [],
        en_preds: [],
      },
    ],
  };

  const snapshot = engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: { strike: spell },
    mmorpg_stat: {
      projectile_count: statEntry("projectile_count", {
        effect: [
          effectBlock("data_modification", ["proj_count"], ["spell_has_tag_projectile"], "Source", ["on_spell_stat_calc"]),
        ],
      }),
    },
    mmorpg_stat_effect: EFFECTS,
    mmorpg_stat_condition: CONDITIONS,
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [exact("projectile_count", "FLAT", 8)]),
    },
  });

  const result = simulateDps(build(), snapshot);
  assert.ok(result);

  // Both carriers are found, and they are genuinely different: the marker opted out.
  assert.equal(result.model.carriers.length, 2);
  assert.deepEqual(
    result.model.carriers.map((c) => (c.kind === "projectile" ? c.count : -1)),
    [1, 9],
  );

  // The headline follows the damage, so it is nine.
  assert.equal(result.multiHit.projectiles, 9);
  assert.equal(result.multiHit.baseProjectiles, 1);
  assert.equal(result.multiHit.bonusProjectiles, 8);

  // And so does the damage itself: two pulses each, across nine projectiles.
  const carried = result.sources.find((s) => s.source.carrier.kind === "projectile");
  assert.ok(carried);
  assert.equal(carried.source.instancesPerCast, 18);
});

// ---------------------------------------------------------------------------
// The 6.4.13 rate: cast_speed_ticks and the shared global cooldown
// ---------------------------------------------------------------------------

/** A stat that writes `cast_speed_perc`, which is where all 40 of the pack's speed stats land. */
function castSpeedStat(value: number): {
  stats: Record<string, Record<string, unknown>>;
  granted: Record<string, unknown>[];
} {
  return {
    stats: {
      attack_cast_speed: statEntry("attack_cast_speed", {
        is_perc: true,
        max: 1000,
        effect: [
          effectBlock("data_modification", ["add_cast_speed_perc"], [], "Source", ["on_spell_stat_calc"]),
        ],
      }),
    },
    granted: [exact("attack_cast_speed", "FLAT", value)],
  };
}

test("cast_speed_ticks governs a spell that declares no cooldown at all", () => {
  // `raging_dragon`'s shape, and the case that made the old model report a 0.05s cycle:
  // `cast_time_ticks: 0, cooldown_ticks: 0, cast_speed_ticks: 15`.
  const result = simulateDps(
    build(),
    scenario({ spellConfig: { cast_time_ticks: 0, cooldown_ticks: 0, cast_speed_ticks: 15 } }),
  );
  assert.ok(result);
  assert.equal(result.calc.offGlobalCooldown, false);
  assert.equal(result.calc.castSpeedTicks, 15);
  // `Spell.getEffectiveCooldownTicks` is `max(getCooldownTicks, getCastSpeedTicks)`, so a
  // declared cooldown of 0 still recovers for 15 ticks.
  assert.equal(result.calc.effectiveCooldownTicks, 15);
  // Plus the one-tick cast floor `getCastTimeTicks` clamps to.
  closeTo(result.rate.cycleSeconds, 16 / 20);
});

test("cast speed divides both the cast and the global cooldown arm", () => {
  const { stats, granted } = castSpeedStat(100);
  const result = simulateDps(
    build(),
    scenario({ spellConfig: { cast_time_ticks: 40, cooldown_ticks: 0, cast_speed_ticks: 40 }, stats, granted }),
  );
  assert.ok(result);
  // `multi = 1 + max(-99, percent) / 100` — +100% is twice as fast, not 100% off.
  closeTo(result.calc.speedMulti, 2);
  assert.equal(result.calc.castTicks, 20, "40 / 2");
  closeTo(result.calc.castSpeedTicks, 20);
  closeTo(result.rate.cycleSeconds, 2);
});

test("the -99% floor keeps a cast finite rather than letting it invert", () => {
  const { stats, granted } = castSpeedStat(-500);
  const result = simulateDps(
    build(),
    scenario({ spellConfig: { cast_time_ticks: 20, cooldown_ticks: 0, cast_speed_ticks: 20 }, stats, granted }),
  );
  assert.ok(result);
  // `Math.max(-99f, percent)` — the multiplier bottoms out at 0.01, so a cast takes 100x as
  // long rather than dividing by zero or going backwards.
  closeTo(result.calc.speedMulti, 0.01);
  assert.ok(result.calc.castTicks > 0);
  assert.ok(Number.isFinite(result.dps));
});

test("the global cooldown floors the cast speed arm", () => {
  const { stats, granted } = castSpeedStat(10_000);
  const result = simulateDps(
    build(),
    scenario({ spellConfig: { cast_time_ticks: 0, cooldown_ticks: 0, cast_speed_ticks: 20 }, stats, granted }),
  );
  assert.ok(result);
  // `Math.max(GLOBAL_COOLDOWN_TICKS, castSpeedTicks / multi)` — no amount of cast speed gets a
  // spell below the pack's global cooldown.
  assert.ok(result.calc.castSpeedTicks >= 2);
});

test("a spell with cast_speed_ticks 0 is off the global cooldown and keeps the old cycle", () => {
  const result = simulateDps(
    build(),
    scenario({ spellConfig: { cast_time_ticks: 20, cooldown_ticks: 40, cast_speed_ticks: 0 } }),
  );
  assert.ok(result);
  // `SpellConfiguration.isOffGlobalCooldown()` is `cast_speed_ticks <= 0`.
  assert.equal(result.calc.offGlobalCooldown, true);
  assert.equal(result.rate.globalCooldownSeconds, 0);
  closeTo(result.rate.cycleSeconds, 3);
});

// ---------------------------------------------------------------------------
// Overlap: carriers that outlive the cast that made them
// ---------------------------------------------------------------------------

/**
 * A spell whose projectile pulses for far longer than its own cast cycle, so casting it
 * repeatedly leaves several casts' worth in the air at once. `raging_dragon`'s shape.
 */
function overlappingScenario({ lifeTicks = 60, tickRate = 10, cooldown = 10 } = {}) {
  const spell = spellEntry("strike", "Physical", "hit100", {
    config: { tags: { tags: [] }, use_support_gems_from: "", cooldown_ticks: cooldown },
  });
  (spell["attached"] as Record<string, unknown>) = {
    entity_components: {
      cloud: [
        {
          acts: [{ type: "damage", map: { element: "Physical", value_calculation: "hit100" } }],
          ifs: [{ type: "x_ticks_condition", map: { tick_rate: tickRate } }],
          targets: [{ type: "aoe", map: { radius: 5, selection_type: "RADIUS", en_predicate: "enemies" } }],
          en_preds: [],
        },
      ],
    },
    on_cast: [
      {
        // `proj_speed: 0` keeps it on the caster, so the flight simulation is not what this
        // test is about — the schedule is.
        acts: [{ type: "projectile", map: { entity_name: "cloud", proj_count: 1, life_ticks: lifeTicks, proj_speed: 0 } }],
        ifs: [{ type: "on_spell_cast", map: {} }],
        targets: [],
        en_preds: [],
      },
    ],
  };
  return engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: { strike: spell },
    mmorpg_stat: {},
    mmorpg_stat_effect: EFFECTS,
    mmorpg_stat_condition: CONDITIONS,
    mmorpg_base_stats: { original_mode_player: baseStats("original_mode_player", []) },
  });
}

test("a carrier outliving the cast cycle is reported as overlapping, with what is in the air", () => {
  // 60-tick projectile, 11-tick cycle (10 cooldown + the 1-tick cast floor).
  const result = simulateDps(build(), overlappingScenario());
  assert.ok(result);

  closeTo(result.rate.cycleSeconds, 11 / 20);
  // The last pulse lands on tick 60, so the source keeps working for 3s after the cast.
  closeTo(result.sources[0]!.durationSeconds, 3);
  assert.equal(result.overlap.overlapping, true);
  closeTo(result.overlap.concurrentCasts, 60 / 11);
  closeTo(result.overlap.projectilesAlive, 60 / 11);
});

test("an instant spell overlaps nothing, and says so", () => {
  const result = simulateDps(build(), scenario({ spellConfig: { cooldown_ticks: 20 } }));
  assert.ok(result);
  assert.equal(result.overlap.overlapping, false);
  assert.equal(result.overlap.projectilesAlive, 0);
  // One cast's worth of an instant hit is happening when it happens — not zero.
  closeTo(result.overlap.concurrentCasts, 1);
  closeTo(result.overlap.rampSeconds, 0);
});

test("sustained DPS already contains the overlap — the ramp converges to it", () => {
  const result = simulateDps(build(), overlappingScenario());
  assert.ok(result);

  // The point of the whole thing: `dps` is a steady-state figure, so the *marginal* rate once
  // the pipeline is full is exactly it. Casts overlapping does not multiply the number, and it
  // was never missing from it.
  //
  // Measured over a whole number of cycles, because casts are discrete: a window that ends
  // mid-cycle has caught a different number of casts than its length implies, and the marginal
  // rate oscillates by up to one cast's worth around the true mean.
  const cycle = result.rate.cycleSeconds;
  const from = 40 * cycle;
  const to = 140 * cycle;
  const marginal = (damageWithin(result, to) - damageWithin(result, from)) / (to - from);

  const error = Math.abs(marginal - result.dps) / result.dps;
  assert.ok(error < 0.001, `marginal rate ${marginal} should be the reported DPS ${result.dps}`);
});

test("the ramp is below the steady-state claim while the pipeline fills", () => {
  const result = simulateDps(build(), overlappingScenario());
  assert.ok(result);

  // At the first cast only the first few pulses have landed, so a `dps x seconds` estimate is
  // badly optimistic. This is what separates a boss from a pack that dies in a second.
  const early = damageWithin(result, 0.5);
  assert.ok(early > 0, "something lands immediately");
  assert.ok(early < result.dps * 0.5 * 0.6, `0.5s in, well under the steady claim (got ${early})`);

  // And it only ever catches up, never overshoots.
  let previous = 0;
  for (const t of [1, 2, 4, 8, 16]) {
    const share = damageWithin(result, t) / (result.dps * t);
    assert.ok(share <= 1.0000001, `never exceeds the steady-state claim at ${t}s (got ${share})`);
    assert.ok(share > previous, `converges upward at ${t}s`);
    previous = share;
  }
});

test("damageWithin is zero before anything lands and monotonic after", () => {
  const result = simulateDps(build(), overlappingScenario());
  assert.ok(result);
  assert.equal(damageWithin(result, -1), 0);
  assert.equal(damageWithin(result, 0), 0, "the first pulse is on tick 10, not tick 0");

  let last = 0;
  for (let t = 0; t <= 5; t += 0.25) {
    const value = damageWithin(result, t);
    assert.ok(value >= last, `never goes backwards at ${t}s`);
    last = value;
  }
});

test("time to kill accounts for the ramp rather than dividing by DPS", () => {
  const result = simulateDps(build(), overlappingScenario());
  assert.ok(result);

  const health = result.dps * 4;
  const ttk = timeToKill(result, health);
  assert.ok(ttk !== undefined);
  // Naively this is 4s. It is longer, because the first seconds are spent filling the pipeline.
  assert.ok(ttk > 4, `ramp makes the kill slower than health/dps (got ${ttk})`);

  // Damage arrives in discrete pulses, so the honest claim is that the target is dead by then
  // and was not dead a moment earlier — not that the totals match to the decimal.
  assert.ok(damageWithin(result, ttk) >= health, "dead by then");
  assert.ok(damageWithin(result, ttk - 0.01) < health, "and not a moment earlier");

  assert.equal(timeToKill(result, 0), 0);
});

// ---------------------------------------------------------------------------
// Full DPS
// ---------------------------------------------------------------------------

test("an unstated main skill is the first that can hit, not the first on the bar", () => {
  // Every capture in this project puts a buff first — `protection`, then the rest — and nothing
  // writes `main`. Taking `live[0]` meant the whole planner reported a build with Quake on it at
  // 0 DPS, and every what-if figure is a difference between two DPS numbers, so the tree hover
  // and the gem ranking read "nothing changes" whatever you did to the build.
  const snapshot = buffScenario({ potionDur: -1 });
  const doc = build({
    skills: [{ spellId: "stance" }, { spellId: "strike" }],
  } as Partial<BuildDoc>);

  const result = simulateDps(doc, snapshot);
  assert.equal(result?.spellId, "strike");
  assert.ok((result?.dps ?? 0) > 0);

  // An explicit `main` still wins outright: the document said so.
  const stated = simulateDps(
    build({ skills: [{ spellId: "stance", main: true }, { spellId: "strike" }] } as Partial<BuildDoc>),
    snapshot,
  );
  assert.equal(stated?.spellId, "stance");

  // And a bar with nothing that hits still answers, rather than returning undefined.
  const buffsOnly = simulateDps(build({ skills: [{ spellId: "stance" }] } as Partial<BuildDoc>), snapshot);
  assert.equal(buffsOnly?.spellId, "stance");
});

test("Full DPS with nothing ticked says so rather than reporting zero as a result", () => {
  const full = simulateFullDps(build(), scenario());
  assert.equal(full.skills.length, 0);
  assert.equal(full.dps, 0);
  assert.ok(full.diagnostics.some((d) => d.code === "full-dps-empty"));
});

test("Full DPS divides by the rotation, because casts share one global cooldown", () => {
  const snapshot = scenario({ spellConfig: { cast_time_ticks: 0, cooldown_ticks: 0, cast_speed_ticks: 20 } });
  const doc = build({
    skills: [{ spellId: "strike", main: true, includeInFullDps: true }],
  } as Partial<BuildDoc>);

  const single = simulateDps(doc, snapshot);
  const full = simulateFullDps(doc, snapshot);
  assert.ok(single);

  // One skill in the rotation: the pass is that skill's cast plus the arm it puts on
  // everything, which is the same cycle the single-skill figure divides by.
  assert.equal(full.skills.length, 1);
  closeTo(full.rotationSeconds, single.rate.cycleSeconds);
  closeTo(full.dps, single.dps);
});

test("adding a second skill to the rotation lengthens the pass rather than stacking DPS", () => {
  const snapshot = scenario({ spellConfig: { cast_time_ticks: 0, cooldown_ticks: 0, cast_speed_ticks: 20 } });
  const one = build({ skills: [{ spellId: "strike", main: true, includeInFullDps: true }] } as Partial<BuildDoc>);
  const two = build({
    skills: [
      { spellId: "strike", main: true, includeInFullDps: true },
      { spellId: "strike", includeInFullDps: true },
    ],
  } as Partial<BuildDoc>);

  const single = simulateFullDps(one, snapshot);
  const paired = simulateFullDps(two, snapshot);

  // Two casts of the same thing do twice the damage over twice the time. A sum would have
  // doubled the DPS, which is exactly what an extender-plus-finisher rotation must not do.
  closeTo(paired.rotationSeconds, single.rotationSeconds * 2);
  closeTo(paired.dps, single.dps);
});

/**
 * A rotation of one attack and one buff.
 *
 * `banishing_blade` is the shape being reproduced: `buff` tag, no `damage` act anywhere in the
 * tree, and an `exile_effect` act on a `self` target whose `potion_dur` decides how often the
 * button has to be pressed. `-1` is the game's sentinel for "never expires".
 */
function buffScenario({
  potionDur = -1,
  buffCooldownTicks = 40,
  buffDamages = false,
  onTarget = false,
  buffTags = ["magic", "buff"],
}: {
  potionDur?: number;
  buffCooldownTicks?: number;
  buffDamages?: boolean;
  /**
   * Put the effect on the pack instead of on yourself — a curse rather than a stance.
   *
   * `curse_of_damnation` is the shape: `damnation` on everything within four blocks for 200
   * ticks, behind a 60-tick cooldown. Which side the effect lands on is read off the enclosing
   * part's target selector and nothing else, which is why this is the only field that changes.
   */
  onTarget?: boolean;
  buffTags?: string[];
} = {}) {
  const strike = spellEntry("strike", "Physical", "hit100", {
    config: { tags: { tags: ["melee"] }, use_support_gems_from: "", cooldown_ticks: 0, cast_time_ticks: 0, cast_speed_ticks: 20 },
  });
  const stance = spellEntry("stance", "Physical", "hit100", {
    config: {
      tags: { tags: buffTags },
      use_support_gems_from: "",
      cooldown_ticks: buffCooldownTicks,
      cast_time_ticks: 5,
      // Every buff in this pack is off the global cooldown, which is what made ticking one look
      // free right up until its own cooldown stretched the pass.
      cast_speed_ticks: 0,
    },
    attached: {
      on_cast: [
        {
          acts: [
            {
              type: "exile_effect",
              map: { count: 1, exile_potion_id: "stance_effect", potion_action: "GIVE_STACKS", potion_dur: potionDur },
            },
          ],
          ifs: [],
          targets: onTarget
            ? [{ type: "aoe", map: { radius: 4, selection_type: "RADIUS", en_predicate: "enemies" } }]
            : [{ type: "self", map: {} }],
          en_preds: [],
        },
        // `power_surge` and `mirror_image` are the pack's own buffs that also hit, and both are
        // tagged `damage` beside `buff`. A buff you press for its damage is a rotation step.
        ...(buffDamages
          ? [
              {
                acts: [{ type: "damage", map: { element: "Physical", value_calculation: "hit100" } }],
                ifs: [],
                targets: [
                  { type: "aoe", map: { radius: 3, selection_type: "RADIUS", en_predicate: "enemies" } },
                ],
                en_preds: [],
              },
            ]
          : []),
      ],
      entity_components: {},
    },
  });

  return engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: { strike, stance },
    mmorpg_stat_effect: EFFECTS,
    mmorpg_stat_condition: CONDITIONS,
  });
}

const ROTATION = { spellId: "strike", main: true, includeInFullDps: true };
const BUFF = { spellId: "stance", includeInFullDps: true };

test("a toggle buff costs the rotation nothing, so ticking it cannot lower Full DPS", () => {
  const snapshot = buffScenario({ potionDur: -1 });
  const alone = simulateFullDps(build({ skills: [ROTATION] } as Partial<BuildDoc>), snapshot);
  const withBuff = simulateFullDps(build({ skills: [ROTATION, BUFF] } as Partial<BuildDoc>), snapshot);

  // The whole finding: `stance` costs 5 ticks to cast and declares a 40-tick cooldown, so the
  // old model both added 0.25s to the pass and stretched it to 2.25s — ticking one free toggle
  // next to a 1.0s skill reported less than half the DPS.
  closeTo(withBuff.rotationSeconds, alone.rotationSeconds);
  closeTo(withBuff.dps, alone.dps);

  const entry = withBuff.skills.find((e) => e.skill.spellId === "stance");
  assert.ok(entry);
  assert.equal(entry.role, "upkeep");
  assert.equal(entry.upkeepSeconds, Infinity);
  assert.equal(entry.upkeepEffectId, "stance_effect");
  assert.equal(entry.rotationSeconds, 0);
});

test("a buff that expires is charged its re-cast share of the pass, and no more", () => {
  // 200 ticks of buff behind a 5-tick cast that arms no global cooldown: one press every 10s,
  // costing 0.25s, against a 1.0s attack.
  const snapshot = buffScenario({ potionDur: 200, buffCooldownTicks: 40 });
  const alone = simulateFullDps(build({ skills: [ROTATION] } as Partial<BuildDoc>), snapshot);
  const full = simulateFullDps(build({ skills: [ROTATION, BUFF] } as Partial<BuildDoc>), snapshot);

  const entry = full.skills.find((e) => e.skill.spellId === "stance");
  assert.ok(entry);
  assert.equal(entry.role, "upkeep");
  closeTo(entry.upkeepSeconds ?? 0, 10);
  closeTo(entry.pressSeconds, 0.25);

  // R = base / (1 - 0.25/10). Solved rather than added, because the share is a fraction of the
  // pass it is being added to.
  closeTo(full.rotationSeconds, alone.rotationSeconds / (1 - 0.025));
  closeTo(entry.rotationSeconds, 0.25 * (full.rotationSeconds / 10));
  // 2.7% longer, not the 24% that charging it a whole press per pass would have cost.
  assert.ok(full.rotationSeconds < alone.rotationSeconds * 1.03);
});

test("a buff whose cooldown outlasts its own effect is paced by the cooldown, and says so", () => {
  // 100 ticks of buff (5s) behind a 400-tick cooldown (20s): you cannot keep it up, and the
  // sheet underneath every figure here assumes you have.
  const snapshot = buffScenario({ potionDur: 100, buffCooldownTicks: 400 });
  const full = simulateFullDps(build({ skills: [ROTATION, BUFF] } as Partial<BuildDoc>), snapshot);

  const entry = full.skills.find((e) => e.skill.spellId === "stance");
  assert.ok(entry);
  closeTo(entry.upkeepDurationSeconds ?? 0, 5);
  // 5 ticks of cast plus 400 of cooldown — the spell's own cycle, which is slower than the buff.
  closeTo(entry.upkeepSeconds ?? 0, 405 / 20);
  assert.ok(full.diagnostics.some((d) => d.code === "full-dps-buff-downtime"));
});

test("a buff that damages stays a rotation step, because that is why you press it", () => {
  const snapshot = buffScenario({ potionDur: -1, buffDamages: true });
  const full = simulateFullDps(build({ skills: [ROTATION, BUFF] } as Partial<BuildDoc>), snapshot);
  const entry = full.skills.find((e) => e.skill.spellId === "stance");
  assert.ok(entry);
  assert.equal(entry.role, "rotation");
});

test("ticking only buffs is a rotation of presses rather than a division by zero", () => {
  const snapshot = buffScenario({ potionDur: -1 });
  const full = simulateFullDps(
    build({ skills: [{ spellId: "stance", main: true, includeInFullDps: true }] } as Partial<BuildDoc>),
    snapshot,
  );

  assert.ok(Number.isFinite(full.rotationSeconds));
  assert.ok(full.rotationSeconds > 0);
  assert.ok(full.diagnostics.some((d) => d.code === "full-dps-buffs-only"));
});

test("Full DPS counts what the rotation procs, against one shared proc cooldown", () => {
  // One skill, one proc, no cap in the way: the rotation figure has to agree with the single
  // skill's, and the single skill's has always reported the proc separately.
  const snapshot = procScenario({ chance: 100 });
  const doc = build({
    skills: [{ spellId: "strike", main: true, includeInFullDps: true }],
  } as Partial<BuildDoc>);

  const single = simulateDps(doc, snapshot);
  const full = simulateFullDps(doc, snapshot);
  assert.ok(single);

  closeTo(full.procDps, single.procDps);
  closeTo(full.skillDps, single.dps);
  // The headline is the two together, which is the whole change: a proc is what the gear you
  // are already wearing does while you press the buttons you already press.
  closeTo(full.dps, single.dps + single.procDps);
});

test("two skills procing one spell share its cooldown rather than each getting one", () => {
  // `strike` casts in 20 ticks and procs `bolt` on every hit; `bolt` may go off once a second.
  // Two of them in the pass trigger twice as often over twice as long — so the proc rate is
  // unchanged, and summing the two per-skill figures would have doubled it.
  const snapshot = procScenario({ chance: 100, procCooldownTicks: 20 });
  const one = build({ skills: [{ spellId: "strike", main: true, includeInFullDps: true }] } as Partial<BuildDoc>);
  const two = build({
    skills: [
      { spellId: "strike", main: true, includeInFullDps: true },
      { spellId: "strike", includeInFullDps: true },
    ],
  } as Partial<BuildDoc>);

  const single = simulateFullDps(one, snapshot);
  const paired = simulateFullDps(two, snapshot);

  closeTo(paired.procDps, single.procDps);
  closeTo(paired.procs[0]!.perSecond, single.procs[0]!.perSecond);
});

test("a proc whose spell is switched off on the Skills tab is listed, not counted", () => {
  // The one route by which a disabled skill could still reach a figure: a procced spell is
  // resolved by id, so the skill list's own `enabled` filter never sees it.
  const snapshot = procScenario({ chance: 100 });
  const doc = build({
    skills: [
      { spellId: "strike", main: true, includeInFullDps: true },
      { spellId: "bolt", enabled: false },
    ],
  } as Partial<BuildDoc>);

  const result = simulateDps(doc, snapshot);
  assert.ok(result);
  const proc = result.procs.find((p) => p.spellId === "bolt");
  assert.ok(proc);
  assert.equal(proc.limit, "disabled");
  closeTo(result.procDps, 0);
  closeTo(simulateFullDps(doc, snapshot).procDps, 0);
});

test("a long individual cooldown stretches the whole rotation, and is named", () => {
  const snapshot = scenario({ spellConfig: { cast_time_ticks: 0, cooldown_ticks: 200, cast_speed_ticks: 20 } });
  const doc = build({ skills: [{ spellId: "strike", main: true, includeInFullDps: true }] } as Partial<BuildDoc>);

  const full = simulateFullDps(doc, snapshot);
  // The cast itself costs 1 + 20 ticks, but you cannot come back round to the skill for 200.
  closeTo(full.rotationSeconds, 201 / 20);
  assert.ok(full.diagnostics.some((d) => d.code === "full-dps-cooldown-bound"));
});


// ---------------------------------------------------------------------------
// Procs
// ---------------------------------------------------------------------------

/**
 * A build whose gear casts `bolt` when the main skill hits, at `chance` percent.
 *
 * `proc_spell` is a `mmorpg_stat_effect`, referenced from a stat's `on_damage` block on the
 * Source side — "when you deal damage" — with `random_roll` reading the stat's own value as the
 * percentage. That is the shape every one of the pack's 99 proc stats has.
 */
function procScenario({
  chance = 100,
  ifs = ["random_roll"],
  procCooldownTicks = 20,
  side = "Source",
  events = ["on_damage"],
}: {
  chance?: number;
  ifs?: string[];
  procCooldownTicks?: number;
  side?: string;
  events?: string[];
} = {}) {
  const main = spellEntry("strike", "Physical", "hit100", {
    config: { tags: { tags: ["melee"] }, use_support_gems_from: "", cooldown_ticks: 0, cast_time_ticks: 20 },
  });
  const bolt = spellEntry("bolt", "Physical", "hit100", {
    config: {
      tags: { tags: [] },
      use_support_gems_from: "",
      cooldown_ticks: 0,
      cast_time_ticks: 20,
      proc_cooldown_ticks: procCooldownTicks,
    },
  });

  return engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: { strike: main, bolt },
    mmorpg_stat: {
      proc_bolt: statEntry("proc_bolt", {
        effect: [{ effects: ["proc_spell_bolt"], events, ifs, order: "final_damage", side }],
      }),
    },
    mmorpg_stat_effect: {
      ...EFFECTS,
      proc_spell_bolt: { id: "proc_spell_bolt", ser: "proc_spell", spellId: "bolt", pos: "CASTER" },
    },
    mmorpg_stat_condition: {
      ...CONDITIONS,
      random_roll: condition("random_roll", "random_roll"),
      spell_has_tag_ranged: condition("spell_has_tag_ranged", "spell_has_tag", { tag: { id: "ranged" } }),
    },
    mmorpg_base_stats: {
      original_mode_player: baseStats("original_mode_player", [exact("proc_bolt", "FLAT", chance)]),
    },
  });
}

/**
 * A spell with no cast speed, so there is something to ask about the rate of.
 *
 * `cast_speed_ticks > 0` is the game's own test for whether a player can cast something
 * (`SpellCastingData`), and 92 of the pack's 432 spells fail it: the whole `cursed_*` family,
 * the curses, `mirror_image`, `power_surge`, `martyrdom`, `eighth_gate`, `blood_harvest`.
 */
function triggeredScenario({
  procCooldownTicks = 15,
  castTimeTicks = 0,
  cooldownTicks = 0,
  procedBy = true,
}: {
  procCooldownTicks?: number;
  castTimeTicks?: number;
  cooldownTicks?: number;
  procedBy?: boolean;
} = {}): ReturnType<typeof engineSnapshot> {
  const cursed = spellEntry("cursed_bolt", "Physical", "hit100", {
    config: {
      tags: { tags: [] },
      use_support_gems_from: "",
      cast_speed_ticks: 0,
      cast_time_ticks: castTimeTicks,
      cooldown_ticks: cooldownTicks,
      proc_cooldown_ticks: procCooldownTicks,
    },
  });

  return engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: { cursed_bolt: cursed },
    mmorpg_stat: procedBy
      ? {
          proc_cursed_bolt: statEntry("proc_cursed_bolt", {
            effect: [
              {
                effects: ["proc_spell_cursed_bolt"],
                events: ["on_damage"],
                ifs: ["random_roll"],
                order: "final_damage",
                side: "Source",
              },
            ],
          }),
        }
      : {},
    mmorpg_stat_effect: procedBy
      ? {
          proc_spell_cursed_bolt: {
            id: "proc_spell_cursed_bolt",
            ser: "proc_spell",
            spellId: "cursed_bolt",
            pos: "CASTER",
          },
        }
      : {},
  });
}

const CURSED: BuildDoc["skills"] = [{ spellId: "cursed_bolt", main: true }];

test("a spell with no cast speed is not castable, and is paced by its proc cooldown", () => {
  // `cursed_raging_dragon` reported **27,403,902 DPS** before this. `cast_speed_ticks: 0` and
  // `cooldown_ticks: 0` left `rateOf` with nothing to divide by but its own floor of one tick,
  // which is twenty casts a second — and eight of the census's top ten were `cursed_*` spells
  // riding that floor.
  //
  // What actually limits a triggered spell is `is_<spell>_not_on_cd`, which `procs.ts` already
  // reads as a cap of `20 / proc_cooldown_ticks`. Pacing the standalone figure the same way makes
  // it a stated ceiling rather than an artefact.
  const result = simulateDps(build({ skills: CURSED } as Partial<BuildDoc>), triggeredScenario());
  assert.ok(result);

  assert.equal(result.rate.castable, false);
  assert.equal(result.rate.procPaced, true);
  // 15 ticks, not 1.
  closeTo(result.rate.cycleSeconds, 0.75);
});

test("the proc cooldown is a repeat interval, so a cast time only binds when it is longer", () => {
  // A proc's cooldown runs from when it fired, so the cast time is not *added* to it — adding
  // them doubled the cycle of every spell in these scenarios, which is how this was caught.
  const shortCast = simulateDps(
    build({ skills: CURSED } as Partial<BuildDoc>),
    triggeredScenario({ procCooldownTicks: 20, castTimeTicks: 5 }),
  );
  assert.ok(shortCast);
  closeTo(shortCast.rate.cycleSeconds, 1);

  const longCast = simulateDps(
    build({ skills: CURSED } as Partial<BuildDoc>),
    triggeredScenario({ procCooldownTicks: 20, castTimeTicks: 60 }),
  );
  assert.ok(longCast);
  closeTo(longCast.rate.cycleSeconds, 3);
});

test("a spell with its own cooldown is still not castable, but the cooldown paces it", () => {
  // `mirror_image` is the shape: off the global cooldown, triggered rather than cast, and
  // carrying a 240-tick cooldown of its own that is far longer than any proc cooldown.
  const result = simulateDps(
    build({ skills: CURSED } as Partial<BuildDoc>),
    triggeredScenario({ cooldownTicks: 240, procCooldownTicks: 10 }),
  );
  assert.ok(result);
  assert.equal(result.rate.castable, false);
  assert.equal(result.rate.procPaced, false, "a real cooldown paces it, not the proc ceiling");
  // The cooldown is the recovery, dwarfing the 10-tick proc ceiling that would otherwise apply.
  closeTo(result.rate.cooldownSeconds, 12);
  assert.ok(result.rate.cycleSeconds >= 12);
});

test("a spell nothing can trigger says so, and a spell something can says what", () => {
  // The inverse lookup. "You have no way to produce this" and "this happens when `X` fires" are
  // different answers, and a figure that cannot tell them apart is not worth printing.
  const orphan = simulateDps(
    build({ skills: CURSED } as Partial<BuildDoc>),
    triggeredScenario({ procedBy: false }),
  );
  assert.ok(orphan);
  const none = orphan.diagnostics.find((d) => d.code === "spell-not-castable");
  assert.ok(none);
  assert.equal(none.severity, "warning");
  assert.match(none.message, /Nothing in the pack procs it/);

  const procced = simulateDps(build({ skills: CURSED } as Partial<BuildDoc>), triggeredScenario());
  assert.ok(procced);
  const named = procced.diagnostics.find((d) => d.code === "spell-not-castable");
  assert.ok(named);
  assert.match(named.message, /proc_cursed_bolt/);
});

test("a castable spell is untouched by any of this", () => {
  // The regression that matters. 340 of the pack's 432 spells declare a cast speed and none of
  // their figures may move because the other 92 were corrected. Declaring one is the whole
  // difference from `triggeredScenario` above.
  const castable = engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: {
      bolt: spellEntry("bolt", "Physical", "hit100", {
        config: {
          tags: { tags: [] },
          use_support_gems_from: "",
          cast_speed_ticks: 20,
          cast_time_ticks: 0,
          cooldown_ticks: 0,
          proc_cooldown_ticks: 15,
        },
      }),
    },
  });

  const result = simulateDps(
    build({ skills: [{ spellId: "bolt", main: true }] } as Partial<BuildDoc>),
    castable,
  );
  assert.ok(result);
  assert.equal(result.rate.castable, true);
  assert.equal(result.rate.procPaced, false);
  // Its own cast speed is the recovery, untouched by the 15-tick proc cooldown beside it.
  // (The cycle is a tick longer: `castTicks` floors at 1 even for a zero cast time.)
  closeTo(result.rate.cooldownSeconds, 1);
  closeTo(result.rate.cycleSeconds, 1.05);
  assert.equal(
    result.diagnostics.some((d) => d.code === "spell-not-castable"),
    false,
  );
});
test("a proc on hit fires at the hit rate times its chance, and its spell's damage is counted", () => {
  // One hit a second (20-tick cast, no cooldown), a proc that always rolls, and a procced spell
  // with a 20-tick proc cooldown — one a second either way, so the cap does not bind.
  const result = simulateDps(build(), procScenario({ chance: 100 }));
  assert.ok(result);

  const proc = result.procs.find((p) => p.spellId === "bolt");
  assert.ok(proc, `expected a bolt proc, got ${result.procs.map((p) => p.spellId).join(", ")}`);
  assert.equal(proc.limit, undefined);
  closeTo(proc.chance, 1);
  closeTo(proc.triggersPerSecond, 1);
  closeTo(proc.perSecond, 1);
  closeTo(proc.damagePerProc, 100);
  closeTo(result.procDps, 100);
});

test("proc_cooldown_ticks caps a proc however often the trigger fires", () => {
  // `is_<spell>_not_on_cd` is on almost every proc block in the pack and is unanswerable from a
  // static document, so the cooldown is applied as a ceiling on the rate instead. At 100 ticks
  // the spell cannot go off more than five times in ten seconds, whatever the roll says.
  const result = simulateDps(build(), procScenario({ chance: 100, procCooldownTicks: 100 }));
  assert.ok(result);

  const proc = result.procs[0]!;
  closeTo(proc.triggersPerSecond, 1);
  closeTo(proc.perSecond, 0.2);
  closeTo(result.procDps, 20);
});

test("half a chance is half a rate", () => {
  const result = simulateDps(build(), procScenario({ chance: 50 }));
  assert.ok(result);
  closeTo(result.procs[0]!.chance, 0.5);
  closeTo(result.procDps, 50);
});

test("a proc restricted to another skill is listed, not counted", () => {
  // `spell_has_tag_ricochet_shot` and friends bind a proc to one skill. Dropping those silently
  // would make "you have no procs" and "your procs belong to a different skill" the same answer.
  const result = simulateDps(
    build(),
    procScenario({ chance: 100, ifs: ["random_roll", "spell_has_tag_ranged"] }),
  );
  assert.ok(result);

  const proc = result.procs[0]!;
  assert.equal(proc.spellId, "bolt");
  assert.equal(proc.limit, "wrong-skill");
  assert.equal(proc.needsTag, "ranged");
  closeTo(result.procDps, 0);
});

test("a proc that fires when you are hit has no rate a damage figure can give it", () => {
  const result = simulateDps(build(), procScenario({ chance: 100, side: "Target" }));
  assert.ok(result);

  assert.equal(result.procs[0]!.limit, "when-hit");
  closeTo(result.procDps, 0);
  assert.ok(result.diagnostics.some((d) => d.code === "proc-rate-unknown"));
});

test("a proc on a kill is listed with no rate, because kills are not a build property", () => {
  const result = simulateDps(build(), procScenario({ chance: 100, events: ["on_mob_kill"] }));
  assert.ok(result);

  assert.equal(result.procs[0]!.limit, "on-kill");
  closeTo(result.procDps, 0);
});


// ---------------------------------------------------------------------------
// Debuffs land on the enemy
// ---------------------------------------------------------------------------

/** A build whose only skill applies `effect` to whatever it hits. */
function debuffScenario(effect: Record<string, unknown>) {
  const strike = spellEntry("strike", "Physical", "hit100", {
    config: { tags: { tags: [] }, use_support_gems_from: "", cooldown_ticks: 20 },
  });
  // The same part that damages also applies the debuff, which is how `puncture` and
  // `flame_strike` are written.
  (strike["attached"] as Record<string, unknown>)["on_cast"] = [
    {
      acts: [
        { type: "damage", map: { element: "Physical", value_calculation: "hit100" } },
        {
          type: "exile_effect",
          map: { exile_potion_id: effect["id"], potion_action: "GIVE_STACKS", count: 1, potion_dur: 200 },
        },
      ],
      ifs: [{ type: "on_spell_cast", map: {} }],
      targets: [{ type: "aoe", map: { radius: 3, selection_type: "RADIUS", en_predicate: "enemies" } }],
      en_preds: [],
    },
  ];

  return engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: { strike },
    mmorpg_exile_effect: { [effect["id"] as string]: effect },
    mmorpg_stat_effect: EFFECTS,
    mmorpg_stat_condition: CONDITIONS,
  });
}

function effectEntry(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    type: "negative",
    max_stacks: 1,
    mc_stats: [],
    one_of_a_kind_id: "",
    spell_tags: { tags: [] },
    stacks_affect_stats: true,
    tags: { tags: [] },
    ...extra,
  };
}

test("a PERCENT debuff scales the enemy's stat, it does not subtract from it", () => {
  // `shred` is `PERCENT -8 armor` stacking to ten. `InCalcStatData` resolves
  // `(base + Flat) * (1 + Percent/100)`, so ten stacks take four fifths off the enemy's armour —
  // adding -80 to it instead would be a rounding error rather than a build-defining debuff.
  const snapshot = debuffScenario(
    effectEntry("shred", { max_stacks: 10, stats: [{ type: "PERCENT", min: -8, max: -8, stat: "armor" }] }),
  );
  // Armour low enough that the mitigation curve is still sensitive: at 4000 against a level-1
  // hit it is already pinned to the 90% floor and no debuff shows through.
  const withEnemy = (effects?: Record<string, boolean | number>) =>
    simulateDps(
      build({ config: { enemy: { level: 1, armor: 100 }, ...(effects ? { effects } : {}) } }),
      snapshot,
    );

  const off = withEnemy({ shred: false });
  const one = withEnemy({ shred: 1 });
  const ten = withEnemy();
  assert.ok(off && one && ten);

  assert.ok(one.dps > off.dps, "one stack strips some armour");
  assert.ok(ten.dps > one.dps, "ten strip more");
  // The debuff is assumed at its cap when the build can apply it and nothing says otherwise.
  assert.equal(ten.effects.options.find((o) => o.id === "shred")?.stacks, 10);
  assert.equal(ten.effects.options.find((o) => o.id === "shred")?.side, "target");
});

test("a debuff on an aggregate resist reaches the elements the layers actually read", () => {
  // `elemental_weakness` — the pack's Scorched — is `FLAT -25 elemental_resist`, and
  // `code-only-effects.ts` registers a mitigation effect per *single* element, skipping
  // `Elemental` entirely. Left on the aggregate the debuff would change nothing at all.
  const strike = spellEntry("strike", "Fire", "hit100", {
    config: { tags: { tags: [] }, use_support_gems_from: "", cooldown_ticks: 20 },
  });
  (strike["attached"] as Record<string, unknown>)["on_cast"] = [
    {
      acts: [
        { type: "damage", map: { element: "Fire", value_calculation: "hit100" } },
        {
          type: "exile_effect",
          map: { exile_potion_id: "elemental_weakness", potion_action: "GIVE_STACKS", count: 1, potion_dur: 200 },
        },
      ],
      ifs: [{ type: "on_spell_cast", map: {} }],
      targets: [{ type: "aoe", map: { radius: 3, selection_type: "RADIUS", en_predicate: "enemies" } }],
      en_preds: [],
    },
  ];
  const snapshot = engineSnapshot({
    mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
    mmorpg_spells: { strike },
    mmorpg_exile_effect: {
      elemental_weakness: effectEntry("elemental_weakness", {
        stats: [{ type: "FLAT", min: -25, max: -25, stat: "elemental_resist" }],
      }),
    },
    mmorpg_stat_effect: EFFECTS,
    mmorpg_stat_condition: CONDITIONS,
  });

  const enemy = { level: 1, resists: { fire: 50 } };
  const off = simulateDps(build({ config: { enemy, effects: { elemental_weakness: false } } }), snapshot);
  const on = simulateDps(build({ config: { enemy } }), snapshot);
  assert.ok(off && on);

  // 50% resist to 25%: the hit lands at 0.75 of its value instead of 0.5.
  closeTo(on.dps / off.dps, 1.5);
});

test("a debuff is rolled at the applying spell's rank, not at its floor", () => {
  // `ExileEffect.getExactStats` interpolates every band at the rank of whatever applied the
  // effect, exactly as a buff does. `applyDebuffs` used to pass 0 and read the minimum, which on
  // a band like `hunters_mark`'s `7.5..15` is half the debuff.
  const snapshot = debuffScenario(
    effectEntry("sunder", { stats: [{ type: "PERCENT", min: -10, max: -90, stat: "armor" }] }),
  );
  const at = (level: number) =>
    simulateDps(
      build({ skills: [{ spellId: "strike", level, main: true }], config: { enemy: { level: 1, armor: 100 } } }),
      snapshot,
    );

  const low = at(1);
  const high = at(20);
  assert.ok(low && high);
  assert.ok(
    high.dps > low.dps,
    "a higher-ranked application strips more armour, because the band rolls higher",
  );
  assert.ok((high.effects.options.find((o) => o.id === "sunder")?.rollPercent ?? 0) > 0);
});

test("a MORE debuff on a stat the target has none of changes nothing, and says so", () => {
  // `InCalcStatData.calcValue` is `(base + Flat) * (1 + Percent/100) * Multi` and MORE feeds only
  // `Multi`, so a MORE modifier on a zero base multiplies zero. `hunters_mark` is the pack's own
  // instance: `MORE 7.5..15 dmg_received`, and `dmg_received` has `base: 0`. Marking a mob is
  // worth literally nothing in game, and an engine that quietly agreed would look like the bug.
  const snapshot = debuffScenario(
    effectEntry("mark", { stats: [{ type: "MORE", min: 15, max: 15, stat: "dmg_received" }] }),
  );
  const off = simulateDps(build({ config: { enemy: { level: 1 }, effects: { mark: false } } }), snapshot);
  const on = simulateDps(build({ config: { enemy: { level: 1 } } }), snapshot);
  assert.ok(off && on);

  closeTo(on.dps, off.dps);
  assert.ok(on.diagnostics.some((d) => d.code === "debuff-more-on-zero-base"));
});
test("a Shatter is its own hit and its own rate, and the two are the same solve", () => {
  // Freeze deals nothing when it lands: `onAilmentCausingDamage` adds to `dmgMap`, and a later
  // hit rolling `freeze_proc_chance` releases the whole entry through `shatterAccumulated`. The
  // pool was already inside `ailmentDps` and had nothing to say how big the spike was, so a cold
  // build could not tell a 40k Shatter from a trickle of bleed. These are the two figures, and
  // what this pins is that they are one arithmetic rather than two: the DPS is the pool times
  // how often it is tipped, so a screen showing both cannot show a rate the spike disagrees with.
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
  const doc = {
    schemaVersion: 1,
    character: { level: 1 },
    skills: [{ spellId: "shard", main: true }],
  } as BuildDoc;

  const result = simulateDps(doc, snapshot);
  assert.ok(result);

  const freeze = result.hit.average.ailments.find((a) => a.ailment === "freeze");
  assert.ok(freeze !== undefined, "a cold hit with freeze chance inflicts freeze");

  const rate = result.rate.castsPerCycle / result.rate.cycleSeconds;

  // The bucket, solved for its level: what you put in per second over what leaves per second.
  // `poolDecayPerSecond` is 0.1 for both strength ailments before `freeze_duration` slows it.
  const expected =
    (freeze.accumulated * freeze.chance * rate) / (freeze.procChance * rate + freeze.poolDecayPerSecond);
  closeTo(result.ailmentHit, expected, "the pool a Shatter finds");
  assert.ok(result.ailmentHit > 0);

  // And the rate is that pool, tipped `procChance` times per cast. Deriving one from the other
  // is the whole point: the spike and the DPS beside it are never two separate estimates.
  closeTo(
    result.ailmentProcDps,
    result.ailmentHit * freeze.procChance * rate,
    "Shatter DPS is the pool times how often it is released",
  );

  // Freeze never ticks, so the whole of the ailment clock here is the pool. A build with a bleed
  // as well would have the difference, which is what the sidebar's two rows are.
  closeTo(freeze.damagePerSecond, 0, "freeze pools instead of ticking");
  closeTo(result.ailmentDps, result.ailmentProcDps, "no DoT here, so the clock is all Shatter");
});

test("the Shatter pool converges on one shatter's worth of hits as the decay stops mattering", () => {
  // The shape worth knowing, and the one a player reasons with: at a fast enough rotation almost
  // nothing leaks, so the pool is "how many hits you land per Shatter" times what each puts in —
  // `accumulated x chance / procChance`. Below that the 10%-a-second decay is the whole
  // difference, which is why a slow rotation has a *smaller* spike and not merely a rarer one.
  const snapshot = (cooldownTicks: number) =>
    engineSnapshot({
      mmorpg_value_calc: { hit100: valueCalcEntry("hit100", { min: 100, max: 100 }) },
      mmorpg_spells: {
        shard: spellEntry("shard", "Cold", "hit100", {
          config: {
            tags: { tags: [] },
            use_support_gems_from: "",
            style: "int",
            cooldown_ticks: cooldownTicks,
          },
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

  const doc = {
    schemaVersion: 1,
    character: { level: 1 },
    skills: [{ spellId: "shard", main: true }],
  } as BuildDoc;

  const fast = simulateDps(doc, snapshot(1));
  const slow = simulateDps(doc, snapshot(200));
  assert.ok(fast && slow);

  const freeze = fast.hit.average.ailments.find((a) => a.ailment === "freeze")!;
  const ceiling = (freeze.accumulated * freeze.chance) / freeze.procChance;

  assert.ok(fast.ailmentHit < ceiling, "the decay always takes something");
  assert.ok(fast.ailmentHit > ceiling * 0.95, "but almost nothing at a fast cast rate");
  assert.ok(slow.ailmentHit < fast.ailmentHit * 0.5, "a ten-second cast leaks most of the pool");
});

test("a curse is paced by how long it sits on the pack, not by its cooldown", () => {
  // The `curse_of_damnation` shape: 200 ticks on the enemy behind a 60-tick cooldown. Nobody
  // re-curses three times over, and a pass that charged three casts said they did.
  const snapshot = buffScenario({ potionDur: 200, buffCooldownTicks: 60, onTarget: true, buffTags: ["area", "curse", "magic"] });
  const full = simulateFullDps(
    build({ skills: [ROTATION, { spellId: "stance", includeInFullDps: true }] } as Partial<BuildDoc>),
    snapshot,
  );

  const entry = full.skills.find((e) => e.skill.spellId === "stance");
  assert.ok(entry);
  assert.equal(entry.role, "upkeep");
  assert.equal(entry.upkeepHolder, "target", "the effect is on the pack, so the pack's clock paces it");
  // Ten seconds of debuff, not the 3.25s the cast plus cooldown would have claimed.
  closeTo(entry.upkeepSeconds ?? 0, 10);
  closeTo(entry.upkeepDurationSeconds ?? 0, 10);
});

test("a curse's own cooldown does not stretch the pass", () => {
  // A 400-tick cooldown next to a 1s attack. As a rotation step the pass waited 20s for it.
  const snapshot = buffScenario({ potionDur: 400, buffCooldownTicks: 400, onTarget: true, buffTags: ["area", "curse", "magic"] });
  const alone = simulateFullDps(build({ skills: [ROTATION] } as Partial<BuildDoc>), snapshot);
  const cursed = simulateFullDps(
    build({ skills: [ROTATION, { spellId: "stance", includeInFullDps: true }] } as Partial<BuildDoc>),
    snapshot,
  );

  assert.ok(cursed.rotationSeconds < alone.rotationSeconds * 1.02);
  assert.ok(!cursed.diagnostics.some((d) => d.code === "full-dps-cooldown-bound"));
});
