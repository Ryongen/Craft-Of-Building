/**
 * Debuffs that procs spend, and the skills that put them back.
 *
 * The case these pin is the Cryolancer's: Cryogenic Rupture fires on a basic attack against a
 * Snow-Tracked enemy and removes a stack each time (`remove_exile_effect`, `stacks: 1`), so it can
 * go off no faster than Tailwind Sweep re-applies Snow-Tracked — however fast you swing. Whiteout
 * Sovereign's storm needs the same stack and does not spend it, so it only rolls on the swings
 * that land before Rupture takes it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BuildDoc } from "@cte2/schema";

import { closeTo, condition, effectBlock, engineSnapshot, statEntry } from "../test-support.js";
import { procPlacement, type DpsResult, type FullDpsResult } from "./dps.js";
import { effectSupply, stacksPerCast } from "./effect-supply.js";
import { NO_EFFECTS } from "./effect-state.js";
import { grantedProcStats } from "./granted.js";
import { resolveProcs } from "./procs.js";
import { skillModel, type EffectApplication } from "./skill-model.js";
import { spellConfig, type SpellCalc } from "./spell-calc.js";

// ---------------------------------------------------------------------------
// The model: what a cast puts on the enemy
// ---------------------------------------------------------------------------

function calc(): SpellCalc {
  return {
    castTicks: 1, castSpeedTicks: 0, effectiveCooldownTicks: 20, castSpeedPercent: 0, speedMulti: 1,
    offGlobalCooldown: true, cooldownTicks: 20, chargeCooldownTicks: 0, manaCost: 0, energyCost: 0,
    bonusProjectiles: 0, bonusChains: 0, areaMulti: 1, durationMulti: 1, projectileSpeedMulti: 1,
    projectileYawSpeedMulti: 1, pierce: false, nova: false, barrage: false, maxTotems: 1,
    maxBanners: 1, extraTotems: 0, extraBanners: 0, bonusTotalSummons: 0, summonType: "none",
  };
}

const give = (effect: string, count = 1): unknown => ({
  type: "exile_effect",
  map: { exile_potion_id: effect, potion_action: "GIVE_STACKS", count, potion_dur: 160 },
});
const aoe = (predicate = "enemies"): unknown => ({
  type: "aoe",
  map: { radius: 2, selection_type: "RADIUS", en_predicate: predicate },
});
const part = (acts: unknown[], ifs: unknown[], targets: unknown[]): unknown => ({
  acts, ifs, targets, en_preds: [], per_entity_hit: [],
});

function modelOf(attached: Record<string, unknown>) {
  const spell = { identifier: "s", config: { tags: { tags: [] }, cooldown_ticks: 20 }, attached };
  return skillModel(spell, spellConfig(spell), calc(), NO_EFFECTS);
}

test("a cast's grants to enemies are recorded, and grants to you are not", () => {
  const onCast = [{ type: "on_spell_cast", map: {} }];
  const model = modelOf({
    on_cast: [
      // `tailwind_sweep`: one Snow-Tracked on everything it sweeps.
      part([give("snow_tracked")], onCast, [aoe()]),
      // The Tailwind stack it hands *you* — a self grant, and never a debuff on the mob.
      part([give("tailwind_sweep")], onCast, [{ type: "self", map: {} }]),
      // An area searching allies is the caster's side too, the same rule `effect-state.ts` uses.
      part([give("protection")], onCast, [aoe("allies")]),
    ],
    entity_components: {},
  });

  assert.deepEqual(model.applications.map((a) => a.effectId), ["snow_tracked"]);
  assert.equal(model.applications[0]!.firesPerCarrier, 1);
});

test("a pulse on a carrier fires once per matching tick of its life", () => {
  // `glacial_dash`: three stacks on every tick of a four-tick dash projectile.
  const model = modelOf({
    on_cast: [
      part(
        [{ type: "projectile", map: { entity_name: "dash", proj_count: 1, life_ticks: 4, proj_speed: 1 } }],
        [{ type: "on_spell_cast", map: {} }],
        [],
      ),
    ],
    entity_components: {
      dash: [part([give("snow_tracked", 3)], [{ type: "x_ticks_condition", map: { tick_rate: 1 } }], [aoe()])],
    },
  });

  const app = model.applications[0]!;
  assert.equal(app.stacks, 3);
  assert.equal(app.firesPerCarrier, 4);
  assert.equal(app.carrier.kind, "projectile");
});

// ---------------------------------------------------------------------------
// Stacks per cast, and whose casts
// ---------------------------------------------------------------------------

const SNOW = engineSnapshot({
  mmorpg_exile_effect: { snow_tracked: { id: "snow_tracked", max_stacks: 3, stats: [] } },
  mmorpg_spells: {
    tailwind_sweep: {
      identifier: "tailwind_sweep",
      config: { tags: { tags: [] } },
      attached: { on_cast: [part([give("snow_tracked")], [{ type: "on_spell_cast", map: {} }], [aoe()])], entity_components: {} },
    },
    glacial_dash: {
      identifier: "glacial_dash",
      config: { tags: { tags: [] } },
      attached: { on_cast: [part([give("snow_tracked", 3)], [{ type: "on_spell_cast", map: {} }], [aoe()])], entity_components: {} },
    },
    fireball: { identifier: "fireball", config: { tags: { tags: [] } }, attached: { on_cast: [], entity_components: {} } },
  },
});

function application(over: Partial<EffectApplication>): EffectApplication {
  return {
    effectId: "snow_tracked",
    stacks: 1,
    trigger: { kind: "on_cast" },
    carrier: { kind: "direct" } as EffectApplication["carrier"],
    firesPerCarrier: 1,
    carriersPerCast: 1,
    castShare: 1,
    ...over,
  };
}

/** The part of a `DpsResult` supply reads: who, how often, and what the model applied. */
function result(spellId: string, cycleSeconds: number, applications: EffectApplication[], lands = true): DpsResult {
  return {
    spellId,
    sources: lands ? [] : [{ coverage: { hitsPerCast: 0 } }],
    model: { applications },
    rate: { cycleSeconds, castsPerCycle: 1 },
  } as unknown as DpsResult;
}

test("a fast pulse refreshes the stacks already there; a slow one hands out new ones", () => {
  // Every tick for ten ticks is one burst up to the cap, not thirty stacks.
  const dash = result("glacial_dash", 3, [
    application({ stacks: 3, trigger: { kind: "tick", rate: 1, firstTick: 0 }, firesPerCarrier: 10 }),
  ]);
  assert.equal(stacksPerCast(SNOW, dash, "snow_tracked"), 3);

  // `banner_of_the_hunt`: one every 30 ticks, and a swing can spend each before the next arrives.
  const banner = result("banner", 8, [
    application({ trigger: { kind: "tick", rate: 30, firstTick: 0 }, firesPerCarrier: 5 }),
  ]);
  assert.equal(stacksPerCast(SNOW, banner, "snow_tracked"), 5);

  // A skill that reaches nothing where the target stands applies nothing to it either.
  assert.equal(stacksPerCast(SNOW, result("tailwind_sweep", 0.35, [application({})], false), "snow_tracked"), 0);
});

const BUILD = (skills: BuildDoc["skills"]): BuildDoc =>
  ({ schemaVersion: 1, character: { level: 100 }, skills }) as BuildDoc;

test("the main skill supplies when it applies the debuff itself", () => {
  const main = result("tailwind_sweep", 0.35, [application({})]);
  const supply = effectSupply(BUILD([{ spellId: "tailwind_sweep" }]), SNOW, "snow_tracked", {
    main,
    resolve: () => assert.fail("the bar is not searched when the main skill answers"),
  });
  assert.equal(supply.basis, "main");
  closeTo(supply.stacksPerSecond, 1 / 0.35);
});

test("a main skill that applies nothing falls back to the fastest applier on the bar", () => {
  // Ice-Tipped Blade asked about on its own: a buff, with Tailwind Sweep and Glacial Dash beside it.
  const main = result("ice_tipped_spear", 2, []);
  const resolved: Record<string, DpsResult> = {
    tailwind_sweep: result("tailwind_sweep", 0.35, [application({})]),
    glacial_dash: result("glacial_dash", 3, [application({ stacks: 3 })]),
  };
  const supply = effectSupply(
    BUILD([{ spellId: "ice_tipped_spear" }, { spellId: "glacial_dash" }, { spellId: "tailwind_sweep" }, { spellId: "fireball" }]),
    SNOW,
    "snow_tracked",
    { main, resolve: (skill) => resolved[skill.spellId] ?? assert.fail(`${skill.spellId} applies nothing and is not resolved`) },
  );
  assert.equal(supply.basis, "bar");
  assert.deepEqual(supply.from.map((f) => f.spellId), ["tailwind_sweep"]);
  closeTo(supply.stacksPerSecond, 1 / 0.35);
});

test("a rotation supplies at the rate the rotation presses, and a disabled skill never does", () => {
  const rotation = {
    rotationSeconds: 2,
    skills: [
      { skill: { spellId: "tailwind_sweep" }, result: result("tailwind_sweep", 0.35, [application({})]), role: "rotation" },
      { skill: { spellId: "glacial_dash" }, result: result("glacial_dash", 3, [application({ stacks: 3 })]), role: "rotation" },
    ],
  } as unknown as FullDpsResult;
  const supply = effectSupply(BUILD([]), SNOW, "snow_tracked", { rotation, resolve: () => undefined });
  assert.equal(supply.basis, "rotation");
  // One press of each per two-second pass: one stack and three.
  closeTo(supply.stacksPerSecond, (1 + 3) / 2);

  const off = effectSupply(
    BUILD([{ spellId: "tailwind_sweep", enabled: false }]),
    SNOW,
    "snow_tracked",
    { resolve: () => assert.fail("a disabled skill is not resolved") },
  );
  assert.equal(off.basis, "none");
  assert.equal(off.stacksPerSecond, 0);
});

// ---------------------------------------------------------------------------
// The procs
// ---------------------------------------------------------------------------

const PROC_STATS = {
    proc_rupture: statEntry("proc_rupture", {
      effect: [
        effectBlock("final_damage", ["proc_spell_rupture", "remove_snow_tracked_from_target"], [
          "random_roll", "is_target_under_snow_tracked", "is_is_basic_atk_true",
        ]),
      ],
    }),
    proc_storm: statEntry("proc_storm", {
      effect: [
        effectBlock("final_damage", ["proc_spell_storm"], ["random_roll", "is_target_under_snow_tracked", "is_is_basic_atk_true"]),
      ],
    }),
};

const PROC_EFFECTS = {
    proc_spell_rupture: { id: "proc_spell_rupture", ser: "proc_spell", spellId: "rupture" },
    proc_spell_storm: { id: "proc_spell_storm", ser: "proc_spell", spellId: "storm" },
    remove_snow_tracked_from_target: {
      id: "remove_snow_tracked_from_target", ser: "remove_exile_effect", effect: "snow_tracked", remove_from: "Target", stacks: 1,
    },
};

const PROCS = engineSnapshot({
  mmorpg_stat: PROC_STATS,
  mmorpg_stat_effect: PROC_EFFECTS,
  mmorpg_stat_condition: {
    is_target_under_snow_tracked: condition("is_target_under_snow_tracked", "is_under_exile_effect", { effect: "snow_tracked", side: "Target" }),
    is_is_basic_atk_true: condition("is_is_basic_atk_true", "is_bool_true", { bool_id: "is_basic_atk" }),
  },
  mmorpg_spells: {
    // One-tick and five-tick proc cooldowns, as the real pair declare.
    rupture: { identifier: "rupture", config: { proc_cooldown_ticks: 1 }, attached: {} },
    storm: { identifier: "storm", config: { proc_cooldown_ticks: 5 }, attached: {} },
  },
});

function swingProcs(stacksPerSecond: number | undefined, sheet: Record<string, number>) {
  return resolveProcs({
    snapshot: PROCS,
    build: BUILD([]),
    effects: NO_EFFECTS,
    onHit: Object.keys(sheet).map((statId) => ({
      statId,
      spellId: statId === "proc_rupture" ? "rupture" : "storm",
      position: "TARGET",
      chance: statId === "proc_rupture" ? 1 : 0.6,
      side: "Source" as const,
    })),
    onCrit: [],
    critChance: 0,
    hitsPerSecond: 5,
    sheet: new Map(Object.entries(sheet).map(([id, value]) => [id, { value }])),
    spellTags: new Set(),
    damageOf: () => 1000,
    ...(stacksPerSecond === undefined
      ? {}
      : {
          supplyOf: (effectId: string) => ({
            effectId,
            stacksPerSecond,
            basis: stacksPerSecond > 0 ? ("main" as const) : ("none" as const),
            from: [],
          }),
        }),
    diagnostics: [],
  });
}

test("a proc that spends a debuff fires no faster than the build puts it back", () => {
  const [rupture] = swingProcs(2.5, { proc_rupture: 100 });
  // Five swings a second, a 100% roll and a one-tick cooldown — and 2.5 Snow-Tracked a second.
  assert.equal(rupture!.triggersPerSecond, 5);
  closeTo(rupture!.perSecond, 2.5);
  assert.equal(rupture!.boundBy, "supply");
  assert.equal(rupture!.consumes?.effectId, "snow_tracked");
  closeTo(rupture!.dps, 2500);

  // Nothing applies it at all: listed, with the reason, rather than dropped or rated on swings.
  const [dry] = swingProcs(0, { proc_rupture: 100 });
  assert.equal(dry!.limit, "no-supply");
  assert.equal(dry!.perSecond, 0);

  // Without a supply answer the old reading stands: the gate as a plain yes.
  const [unasked] = swingProcs(undefined, { proc_rupture: 100 });
  closeTo(unasked!.perSecond, 5);
  assert.equal(unasked!.consumes, undefined);
});

test("a proc that needs the same debuff only rolls on the swings that find it", () => {
  const procs = swingProcs(2.5, { proc_rupture: 100, proc_storm: 60 });
  const storm = procs.find((p) => p.spellId === "storm")!;
  // Rupture takes every stack on the first swing after it lands, so 2.5 swings a second see a
  // Snow-Tracked target, and the storm's 60% roll is taken on those.
  closeTo(storm.perSecond, 2.5 * 0.6);
  assert.equal(storm.boundBy, "supply");
  assert.deepEqual(storm.competes, { effectId: "snow_tracked", spentBy: "proc_rupture" });

  // With no spender on the sheet the storm is back to every swing, capped by its own cooldown.
  const [alone] = swingProcs(2.5, { proc_storm: 60 });
  closeTo(alone!.perSecond, Math.min(5 * 0.6, 20 / 5));
  assert.equal(alone!.competes, undefined);
});

// ---------------------------------------------------------------------------
// What a skill grants
// ---------------------------------------------------------------------------

test("a buff's granted procs are the proc stats on the effect it puts on you", () => {
  const snapshot = engineSnapshot({
    mmorpg_spells: {
      ice_tipped_spear: {
        identifier: "ice_tipped_spear",
        config: { tags: { tags: [] } },
        attached: {
          on_cast: [part([give("ice_tipped_spear")], [{ type: "on_spell_cast", map: {} }], [{ type: "self", map: {} }])],
          entity_components: {},
        },
      },
      tailwind_sweep: {
        identifier: "tailwind_sweep",
        config: { tags: { tags: [] } },
        attached: { on_cast: [part([give("proc_buff_on_mob")], [{ type: "on_spell_cast", map: {} }], [aoe()])], entity_components: {} },
      },
    },
    mmorpg_exile_effect: {
      ice_tipped_spear: {
        id: "ice_tipped_spear",
        stats: [
          { type: "MORE", min: 5, max: 10, stat: "spear_damage" },
          { type: "FLAT", min: 100, max: 100, stat: "proc_rupture" },
        ],
      },
      // Granted to the enemy, so its stats are the enemy's and never a proc of yours.
      proc_buff_on_mob: { id: "proc_buff_on_mob", stats: [{ type: "FLAT", min: 1, max: 1, stat: "proc_storm" }] },
    },
    mmorpg_stat: {
      spear_damage: statEntry("spear_damage"),
      ...PROC_STATS,
    },
    mmorpg_stat_effect: PROC_EFFECTS,
  });

  const granted = grantedProcStats(snapshot, "ice_tipped_spear");
  assert.deepEqual([...granted.keys()], ["proc_rupture"]);
  assert.equal(granted.get("proc_rupture")!.basicOnly, true);
  assert.equal(grantedProcStats(snapshot, "tailwind_sweep").size, 0);
});

test("a TARGET proc is resolved from the enemy it was triggered on", () => {
  // `ProcSpellEffect.activate`: `SpellCtx.onCast(source, calc)`, then `setPositionSource(pos)` and
  // `ctx.target = <struck entity>`. Cryogenic Rupture's burst is a 0.5-block area around that.
  const snapshot = engineSnapshot({
    ...Object.fromEntries(Object.entries(PROCS.registries).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([id, e]) => [id, e.data]))])),
    mmorpg_stat_effect: { ...PROC_EFFECTS, proc_spell_rupture: { ...PROC_EFFECTS.proc_spell_rupture, pos: "TARGET" } },
  });
  const asked: string[] = [];
  resolveProcs({
    snapshot,
    build: BUILD([]),
    effects: NO_EFFECTS,
    onHit: [{ statId: "proc_rupture", spellId: "rupture", position: "TARGET", chance: 1, side: "Source" }],
    onCrit: [],
    critChance: 0,
    hitsPerSecond: 1,
    sheet: new Map([["proc_rupture", { value: 100 }]]),
    spellTags: new Set(),
    damageOf: (_spell, position) => {
      asked.push(position);
      return 1;
    },
    diagnostics: [],
  });
  assert.deepEqual(asked, ["TARGET"]);

  const placement = { distance: 2, radius: 0.3, bearing: 0, height: 1 };
  assert.equal(procPlacement(placement, "TARGET").distance, 0);
  assert.equal(procPlacement(placement, "CASTER"), placement);
});
