/**
 * What a cast produces.
 *
 * Every number asserted here is quoted from the jar the snapshot was extracted from
 * (`Mine_and_Slash-1.20.1-6.4.13.jar`) or from `reference/mns-src` where the two agree. The
 * arithmetic that matters most is the tick count: `OnTickCondition` against the entity's own
 * `tickCount`, over the range `SimpleProjectileEntity.tick` actually runs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { gatedEffectIds, skillModel } from "./skill-model.js";
import type { EffectState } from "./effect-state.js";
import { spellConfig, type SpellCalc } from "./spell-calc.js";

/** A calculated spell with nothing modified — the identity, so a test isolates one field. */
function calc(overrides: Partial<SpellCalc> = {}): SpellCalc {
  return {
    castTicks: 1,
    castSpeedTicks: 0,
    effectiveCooldownTicks: 20,
    castSpeedPercent: 0,
    speedMulti: 1,
    offGlobalCooldown: true,
    cooldownTicks: 20,
    chargeCooldownTicks: 0,
    manaCost: 0,
    energyCost: 0,
    bonusProjectiles: 0,
    bonusChains: 0,
    areaMulti: 1,
    durationMulti: 1,
    projectileSpeedMulti: 1,
    projectileYawSpeedMulti: 1,
    pierce: false,
    nova: false,
    barrage: false,
    // `getMaxSummons` floors at 1, so a character with no `max_totems` stat is the identity here.
    maxTotems: 1,
    maxBanners: 1,
    extraTotems: 0,
    extraBanners: 0,
    bonusTotalSummons: 0,
    summonType: "none",
    ...overrides,
  };
}

function part(
  acts: unknown[],
  ifs: unknown[] = [],
  targets: unknown[] = [],
  perEntityHit: unknown[] = [],
): unknown {
  return { acts, ifs, targets, en_preds: [], per_entity_hit: perEntityHit };
}

const damageAct = (calcId: string, element = "Fire"): unknown => ({
  type: "damage",
  map: { element, value_calculation: calcId },
});

const aoe = (radius: number): unknown => ({
  type: "aoe",
  map: { radius, selection_type: "RADIUS", en_predicate: "enemies" },
});

function spell(attached: Record<string, unknown>, config: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identifier: "test_spell",
    config: { tags: { tags: [] }, cooldown_ticks: 20, ...config },
    attached,
  };
}

function modelOf(attached: Record<string, unknown>, c: SpellCalc = calc(), effects = up()) {
  const s = spell(attached);
  return skillModel(s, spellConfig(s), c, effects);
}

/** As `modelOf`, but the spell's own `config` matters — `times_to_cast` is read off it. */
function modelOfConfigured(attached: Record<string, unknown>, config: Record<string, unknown>) {
  const s = spell(attached, config);
  return skillModel(s, spellConfig(s), calc(), up());
}

/**
 * An effect state with the named effects up, at the stacks given.
 *
 * Only the three fields the gates read are filled: `skillModel` asks `active` and nothing else,
 * and building a whole availability scan to test a branch table would be testing the wrong file.
 */
function up(active: Record<string, number> = {}): EffectState {
  return {
    assume: "available",
    options: Object.entries(active).map(([id, stacks]) => ({
      id,
      side: "caster" as const,
      kind: "beneficial" as const,
      hasStats: false,
      maxStacks: stacks,
      declaredMaxStacks: stacks,
      group: "",
      grantedBy: [],
      stacks,
      chosen: true,
      captured: false,
      rollPercent: 0,
      strMulti: 1,
    })),
    active: new Map(Object.entries(active)),
    chosenOfGroup: new Map(),
  };
}

test("an on_cast damage act is one direct source", () => {
  const model = modelOf({ on_cast: [part([damageAct("slam")], [{ type: "on_spell_cast", map: {} }], [aoe(2)])] });

  assert.equal(model.sources.length, 1);
  const source = model.sources[0]!;
  assert.equal(source.valueCalcId, "slam");
  assert.equal(source.carrier.kind, "direct");
  assert.equal(source.trigger.kind, "on_cast");
  assert.equal(source.instancesPerCast, 1);
});

test("both damage acts of a two-source spell are found, not just the first in tree order", () => {
  // The shape of `raging_dragon`: the carried tick source is declared *before* `on_cast` in the
  // JSON, so a walk that stops at the first `damage` act finds the wrong one and loses the other.
  const model = modelOf({
    entity_components: {
      default_entity_name: [
        part([damageAct("pulse")], [{ type: "x_ticks_condition", map: { tick_rate: 4 } }], [aoe(2)]),
      ],
    },
    on_cast: [
      part(
        [{ type: "projectile", map: { entity_name: "default_entity_name", proj_count: 1, life_ticks: 60, proj_speed: 0.25 } }],
        [{ type: "on_spell_cast", map: {} }],
      ),
      part([damageAct("slam")], [{ type: "on_spell_cast", map: {} }], [aoe(2)]),
    ],
  });

  const ids = model.sources.map((s) => s.valueCalcId).sort();
  assert.deepEqual(ids, ["pulse", "slam"]);
});

test("a tick-gated source fires once per tick_rate over the carrier's whole life", () => {
  const model = modelOf({
    entity_components: {
      default_entity_name: [
        part([damageAct("pulse")], [{ type: "x_ticks_condition", map: { tick_rate: 4 } }], [aoe(2)]),
      ],
    },
    on_cast: [
      part([
        { type: "projectile", map: { entity_name: "default_entity_name", proj_count: 1, life_ticks: 60, proj_speed: 0.25 } },
      ]),
    ],
  });

  const source = model.sources[0]!;
  // `tick()` runs `onTick()` before the `tickCount >= deathTime` check, so ticks 1..60 are all
  // live and 4, 8, … 60 pass `tickCount % 4 == 0`. That is 15, not 14 and not 16.
  assert.equal(source.firesPerCarrier, 15);
  assert.equal(source.instancesPerCast, 15);
});

test("first_tick shifts the phase as well as the start", () => {
  const model = modelOf({
    entity_components: {
      en: [part([damageAct("pulse")], [{ type: "x_ticks_condition", map: { tick_rate: 20, first_tick: 20 } }], [aoe(2)])],
    },
    on_cast: [part([{ type: "projectile", map: { entity_name: "en", proj_count: 1, life_ticks: 100, proj_speed: 1 } }])],
  });

  // `tickCount >= 20 && tickCount % 20 == 0` over 1..100 — 20, 40, 60, 80, 100.
  assert.equal(model.sources[0]!.firesPerCarrier, 5);
});

test("tick_rate 0 fires exactly once, on first_tick", () => {
  const model = modelOf({
    entity_components: {
      en: [part([damageAct("boom")], [{ type: "x_ticks_condition", map: { tick_rate: 0, first_tick: 20 } }], [aoe(2)])],
    },
    on_cast: [part([{ type: "projectile", map: { entity_name: "en", proj_count: 1, life_ticks: 100, proj_speed: 1 } }])],
  });

  // `else { return tickCount == firstTick; }`
  assert.equal(model.sources[0]!.firesPerCarrier, 1);
});

test("bonus projectiles multiply the carrier, and ignore_bonus_proj opts out", () => {
  const attached = (ignore: boolean): Record<string, unknown> => ({
    entity_components: {
      en: [part([damageAct("pulse")], [{ type: "x_ticks_condition", map: { tick_rate: 10 } }], [aoe(2)])],
    },
    on_cast: [
      part([
        {
          type: "projectile",
          map: {
            entity_name: "en",
            proj_count: 1,
            life_ticks: 20,
            proj_speed: 1,
            ...(ignore ? { ignore_bonus_proj: true } : {}),
          },
        },
      ]),
    ],
  });

  const withBonus = modelOf(attached(false), calc({ bonusProjectiles: 8 }));
  const carrier = withBonus.sources[0]!.carrier;
  assert.equal(carrier.kind === "projectile" && carrier.count, 9);
  // 9 projectiles × 2 pulses each (ticks 10 and 20).
  assert.equal(withBonus.sources[0]!.instancesPerCast, 18);

  const ignored = modelOf(attached(true), calc({ bonusProjectiles: 8 }));
  const ignoredCarrier = ignored.sources[0]!.carrier;
  assert.equal(ignoredCarrier.kind === "projectile" && ignoredCarrier.count, 1);
});

test("a projectile ignores duration by default; a summoned block never can", () => {
  const c = calc({ durationMulti: 2 });

  const projectile = modelOf(
    {
      entity_components: { en: [part([damageAct("x")], [{ type: "on_entity_expire", map: {} }], [aoe(2)])] },
      on_cast: [part([{ type: "projectile", map: { entity_name: "en", proj_count: 1, life_ticks: 40, proj_speed: 1 } }])],
    },
    c,
  );
  // `getOrDefault(UNAFFECTED_BY_DURATION, true)` — the default is to ignore it.
  assert.equal(projectile.sources[0]!.carrier.lifeTicks, 40);

  const optedIn = modelOf(
    {
      entity_components: { en: [part([damageAct("x")], [{ type: "on_entity_expire", map: {} }], [aoe(2)])] },
      on_cast: [
        part([
          {
            type: "projectile",
            map: { entity_name: "en", proj_count: 1, life_ticks: 40, proj_speed: 1, unaffect_by_duration: false },
          },
        ]),
      ],
    },
    c,
  );
  assert.equal(optedIn.sources[0]!.carrier.lifeTicks, 80);

  const block = modelOf(
    {
      entity_components: {
        en: [part([damageAct("x")], [{ type: "x_ticks_condition", map: { tick_rate: 20 } }], [aoe(2)])],
      },
      on_cast: [part([{ type: "summon_block", map: { entity_name: "en", life_ticks: 40, block: "minecraft:fire" } }])],
    },
    c,
  );
  // `StationaryFallingBlockEntity` multiplies by `DURATION_MULTI` with no opt-out at all.
  assert.equal(block.sources[0]!.carrier.lifeTicks, 80);
});

test("AREA_MULTI widens the radius the source resolves against", () => {
  const model = modelOf(
    { on_cast: [part([damageAct("slam")], [{ type: "on_spell_cast", map: {} }], [aoe(2)])] },
    calc({ areaMulti: 1.3 }),
  );
  const target = model.sources[0]!.target;
  assert.equal(target.kind, "aoe");
  assert.ok(target.kind === "aoe" && Math.abs(target.radius - 2.6) < 1e-9);
});

test("a component group nothing spawns is reported rather than counted", () => {
  const model = modelOf({
    entity_components: {
      orphan: [part([damageAct("never")], [{ type: "on_entity_expire", map: {} }], [aoe(2)])],
    },
    on_cast: [part([damageAct("slam")], [{ type: "on_spell_cast", map: {} }], [aoe(2)])],
  });

  assert.deepEqual(model.sources.map((s) => s.valueCalcId), ["slam"]);
  assert.deepEqual(model.unreachableGroups, ["orphan"]);
});

test("specific_action reaches a group without changing the carrier", () => {
  // `DoSpecificAction` runs the named group's parts in the *current* context, so a group
  // invoked from `on_cast` resolves around the caster, not around some entity.
  const model = modelOf({
    entity_components: {
      explode: [part([damageAct("boom")], [], [aoe(3)])],
    },
    on_cast: [part([{ type: "specific_action", map: { specific_action: "explode" } }], [{ type: "on_spell_cast", map: {} }])],
  });

  assert.equal(model.sources.length, 1);
  assert.equal(model.sources[0]!.carrier.kind, "direct");
  assert.deepEqual(model.unreachableGroups, []);
});

const gated = {
  on_cast: [
    part(
      [damageAct("slam")],
      [
        { type: "on_spell_cast", map: {} },
        { type: "caster_has_mns_effect", map: { exile_potion_id: "combo_extender" } },
      ],
      [aoe(2)],
    ),
  ],
};

test("caster_has_mns_effect is carried through as a requirement when it is satisfied", () => {
  const model = modelOf(gated, calc(), up({ combo_extender: 1 }));

  assert.deepEqual(model.sources[0]!.requires, [
    {
      kind: "exile_effect",
      effectId: "combo_extender",
      holder: "caster",
      negated: false,
      minimumStacks: 1,
    },
  ]);
  assert.equal(model.blockedBy.length, 0);
});

test("a part whose gate fails produces nothing, and says what it was waiting on", () => {
  // `ComponentPart.tryActivate` returns before it resolves a target when `conditionsPass` is
  // false, so the acts never run. `raging_dragon` really does nothing at all without its
  // extender, and reporting its damage anyway was the old model's most generous assumption.
  const model = modelOf(gated, calc(), up());

  assert.equal(model.sources.length, 0);
  assert.deepEqual(model.blockedBy, [
    {
      requirement: {
        kind: "exile_effect",
        effectId: "combo_extender",
        holder: "caster",
        negated: false,
        minimumStacks: 1,
      },
      damageActs: 1,
      activeStacks: 0,
    },
  ]);
});

test("effect_stacks is a floor, so a gate can ask for four of something", () => {
  // `armageddon` declares its meteor stream twice, the second copy behind
  // `caster_has_mns_effect { exile_potion_id: overheat, effect_stacks: 4 }`.
  const attached = {
    on_cast: [
      part(
        [damageAct("meteor")],
        [
          { type: "on_spell_cast", map: {} },
          { type: "caster_has_mns_effect", map: { exile_potion_id: "overheat", effect_stacks: 4 } },
        ],
        [aoe(2)],
      ),
    ],
  };

  assert.equal(modelOf(attached, calc(), up({ overheat: 3 })).sources.length, 0);
  assert.equal(modelOf(attached, calc(), up({ overheat: 4 })).sources.length, 1);
});

/**
 * `execute`, which is the pack's only `caster_has_potion` user and declares its damage twice.
 *
 * Both parts put the gate in `en_preds` rather than `ifs`, which is where the real spell has it —
 * `CasterHasEffectCondition.canActivate` reads `ctx.caster` either way.
 */
const invisibilityBranches = {
  on_cast: [
    {
      acts: [damageAct("execute")],
      ifs: [{ type: "on_spell_cast", map: {} }],
      targets: [aoe(2)],
      en_preds: [
        { type: "caster_has_potion", map: { potion_id: "minecraft:invisibility", is_false: true } },
      ],
      per_entity_hit: [],
    },
    {
      acts: [damageAct("execute_double")],
      ifs: [{ type: "on_spell_cast", map: {} }],
      targets: [aoe(2)],
      en_preds: [{ type: "caster_has_potion", map: { potion_id: "minecraft:invisibility" } }],
      per_entity_hit: [],
    },
  ],
};

function potionModel(conditions?: Record<string, boolean>) {
  const s = spell(invisibilityBranches);
  return skillModel(s, spellConfig(s), calc(), up(), "on_cast", conditions);
}

test("a vanilla potion is assumed absent, so only one of two exclusive branches fires", () => {
  // Unread, both parts passed and one press reported three times the hit the game deals —
  // `execute` and `execute_double` are mutually exclusive, not cumulative.
  const model = potionModel();

  assert.deepEqual(
    model.sources.map((s) => s.valueCalcId),
    ["execute"],
  );
  assert.deepEqual(model.blockedBy, [
    {
      requirement: {
        kind: "potion",
        effectId: "minecraft:invisibility",
        holder: "caster",
        negated: false,
        minimumStacks: 1,
      },
      damageActs: 1,
      activeStacks: 0,
    },
  ]);
});

test("config.conditions is what answers a potion gate, and it flips the pair", () => {
  const model = potionModel({ "caster_has_potion:minecraft:invisibility": true });

  assert.deepEqual(
    model.sources.map((s) => s.valueCalcId),
    ["execute_double"],
  );
  assert.equal(model.blockedBy.length, 1);
  assert.equal(model.blockedBy[0]!.requirement.negated, true);
});

test("a potion id never reaches the exile-effect tiebreak", () => {
  // `gatedEffectIds` feeds `one_of_a_kind_id` resolution, and `minecraft:invisibility` is not an
  // `mmorpg_exile_effect` — letting it through would have the engine hunting for one.
  assert.deepEqual(gatedEffectIds(spell(invisibilityBranches)), []);
});

test("is_false inverts the gate, which is how a spell writes its default branch", () => {
  // `soul_siphon`'s plain branch is four negated gates: no aura of any of the three kinds.
  const attached = {
    on_cast: [
      part(
        [damageAct("plain")],
        [
          { type: "on_spell_cast", map: {} },
          { type: "caster_has_mns_effect", map: { exile_potion_id: "plague_aura", is_false: true } },
        ],
        [aoe(2)],
      ),
      part(
        [damageAct("plagued")],
        [
          { type: "on_spell_cast", map: {} },
          { type: "caster_has_mns_effect", map: { exile_potion_id: "plague_aura" } },
        ],
        [aoe(2)],
      ),
    ],
  };

  assert.deepEqual(
    modelOf(attached, calc(), up()).sources.map((s) => s.valueCalcId),
    ["plain"],
  );
  assert.deepEqual(
    modelOf(attached, calc(), up({ plague_aura: 1 })).sources.map((s) => s.valueCalcId),
    ["plagued"],
  );
});

test("an act this model does not interpret is named rather than ignored", () => {
  const model = modelOf({
    on_cast: [part([{ type: "some_future_act", map: {} }], [{ type: "on_spell_cast", map: {} }])],
  });
  assert.deepEqual(model.unmodelledActs, ["some_future_act"]);
});


// ---------------------------------------------------------------------------
// per_entity_hit
// ---------------------------------------------------------------------------

test("a per_entity_hit act is reached, and answers to the outer part's selector", () => {
  // `ComponentPart.tryActivate` runs these once per entity the selector above picked, through
  // `SpellCtx.onEntityHit`, and the acts run against `Arrays.asList(entity)` — the sub-part
  // declares no selector of its own. So the outer `aoe` is what decides whether it lands.
  const model = modelOf({
    on_cast: [
      part(
        [damageAct("slam")],
        [{ type: "on_spell_cast", map: {} }],
        [aoe(3)],
        [{ acts: [damageAct("follow_up", "Cold")], ifs: [], targets: [], en_preds: [] }],
      ),
    ],
  });

  assert.equal(model.sources.length, 2);
  const inner = model.sources[1]!;
  assert.equal(inner.valueCalcId, "follow_up");
  assert.deepEqual(inner.target, { kind: "aoe", radius: 3, selectionChance: 1 });
  assert.equal(inner.trigger.kind, "on_cast");
  // `SpellCtx.onEntityHit` sets `PositionSource.TARGET`.
  assert.equal(inner.origin.atTarget, true);
});

test("a projectile spawned inside per_entity_hit starts on the enemy that was hit", () => {
  // The shape of `frozen_orb`: the orb's on-hit part spawns shards through `per_entity_hit`, so
  // they are launched from the mob rather than from the orb or the caster.
  const model = modelOf({
    entity_components: {
      shard: [part([damageAct("shard")], [{ type: "on_entity_expire", map: {} }], [aoe(1)])],
      orb: [
        part(
          [],
          [{ type: "on_hit", map: {} }],
          [aoe(1)],
          [
            {
              acts: [{ type: "projectile", map: { entity_name: "shard", proj_count: 5, life_ticks: 12, proj_speed: 0.5 } }],
              ifs: [],
              targets: [],
              en_preds: [],
            },
          ],
        ),
      ],
    },
    on_cast: [
      part(
        [{ type: "projectile", map: { entity_name: "orb", proj_count: 1, life_ticks: 60, proj_speed: 0.25 } }],
        [{ type: "on_spell_cast", map: {} }],
      ),
    ],
  });

  assert.equal(model.unreachableGroups.length, 0);
  const shard = model.sources.find((s) => s.valueCalcId === "shard");
  assert.ok(shard);
  assert.deepEqual(shard.origin.chain.map((step) => step.from.kind), ["parent", "target"]);
  assert.equal(shard.origin.chain[1]!.spawnedOn.kind, "on_hit");
});

// ---------------------------------------------------------------------------
// The spawn chain
// ---------------------------------------------------------------------------

test("a carrier spawned by another carrier counts once per parent, not once per cast", () => {
  // `fire_wall`: five projectiles, each laying one wall down when it expires, each wall pulsing
  // every five ticks for 160. Reading `carrier.count` alone reports one wall and a fifth of the
  // spell.
  const model = modelOf({
    entity_components: {
      wall: [part([damageAct("burn")], [{ type: "x_ticks_condition", map: { tick_rate: 5 } }], [aoe(0.5)])],
      bolt: [
        part(
          [{ type: "summon_block", map: { entity_name: "wall", life_ticks: 160 } }],
          [{ type: "on_entity_expire", map: {} }],
        ),
      ],
    },
    on_cast: [
      part(
        [{ type: "projectile", map: { entity_name: "bolt", proj_count: 5, life_ticks: 100, proj_speed: 1 } }],
        [{ type: "on_spell_cast", map: {} }],
      ),
    ],
  });

  const wall = model.sources[0]!;
  assert.equal(wall.carrier.kind, "summon_block");
  assert.equal(wall.carriersPerCast, 5);
  // 1..160 inclusive, every fifth tick: 32 pulses each.
  assert.equal(wall.firesPerCarrier, 32);
  assert.equal(wall.instancesPerCast, 160);
});

test("a block dropped every few ticks of its parent's life is counted once per drop", () => {
  // `armageddon`: the block ticks every five over fifteen ticks, so three meteors — and each
  // meteor is its own carrier, not three firings of one.
  const model = modelOf({
    entity_components: {
      meteor: [part([damageAct("impact")], [{ type: "on_entity_expire", map: {} }], [aoe(2)])],
      cloud: [
        part(
          [{ type: "summon_block", map: { entity_name: "meteor", life_ticks: 200, random_x_offset: 2, random_z_offset: 2 } }],
          [{ type: "x_ticks_condition", map: { tick_rate: 5 } }],
        ),
      ],
    },
    on_cast: [
      part(
        [{ type: "summon_at_sight", map: { entity_name: "cloud", life_ticks: 15 } }],
        [{ type: "on_spell_cast", map: {} }],
      ),
    ],
  });

  const meteor = model.sources[0]!;
  assert.equal(meteor.carriersPerCast, 3);
  assert.equal(meteor.instancesPerCast, 3);
  assert.deepEqual(meteor.origin.chain.map((step) => step.from.kind), ["sight", "parent"]);
  assert.deepEqual(meteor.origin.chain[1]!.scatter, { x: 2, z: 2 });
});

test("summon_at_sight only ray-picks when nothing has moved the context off the caster", () => {
  // `SummonAtSightAction` picks from the caster's eyes only when the position entity *is* the
  // caster; nested inside a projectile's group — `meteor_arrow`'s `height_en` — it is placed on
  // the projectile instead.
  const nested = modelOf({
    entity_components: {
      fall: [part([damageAct("impact")], [{ type: "on_entity_expire", map: {} }], [aoe(2)])],
      arrow: [
        part(
          [{ type: "summon_at_sight", map: { entity_name: "fall", life_ticks: 10 } }],
          [{ type: "on_entity_expire", map: {} }],
        ),
      ],
    },
    on_cast: [
      part(
        [{ type: "projectile", map: { entity_name: "arrow", proj_count: 1, life_ticks: 40, proj_speed: 1 } }],
        [{ type: "on_spell_cast", map: {} }],
      ),
    ],
  });

  assert.deepEqual(nested.sources[0]!.origin.chain.map((step) => step.from.kind), ["parent", "parent"]);
});

test("an on_hit part resolves at the enemy it touched, not at the projectile", () => {
  // `SpellCtx.onHit` sets `PositionSource.TARGET`, which is both where its area is centred and
  // where anything it spawns starts.
  const model = modelOf({
    entity_components: {
      bolt: [part([damageAct("zap")], [{ type: "on_hit", map: {} }], [aoe(1)])],
    },
    on_cast: [
      part(
        [{ type: "projectile", map: { entity_name: "bolt", proj_count: 1, life_ticks: 40, proj_speed: 1 } }],
        [{ type: "on_spell_cast", map: {} }],
      ),
    ],
  });

  assert.equal(model.sources[0]!.origin.atTarget, true);
});

test("a part gated on the first or last cast fires once per press, not once per cast", () => {
  // `SpellCastingData` runs a `times_to_cast` spell as that many casts off one press, and
  // `is_first_cast` / `is_last_cast` pick one of them out. Neither gate was read by anything,
  // so a part behind one ran on every cast — and an unread gate does not fail, it reads as
  // true. Everything downstream then multiplies the per-cast figure by `rate.castsPerCycle`,
  // so the error is exactly `times_to_cast`.
  //
  // `storming_tiger` is the one that costs damage: `times_to_cast: 4`, and its `on_cast[5]`
  // throws a projectile behind `is_last_cast`. The pack's other four uses grant an exile effect
  // and cost nothing.
  const model = modelOfConfigured(
    {
      on_cast: [
        part([damageAct("every")], [], [aoe(3)]),
        part([damageAct("last")], [{ type: "is_last_cast", map: {} }], [aoe(3)]),
      ],
    },
    { times_to_cast: 4 },
  );

  assert.equal(model.sources.length, 2);
  const everyCast = model.sources.find((s) => s.valueCalcId === "every");
  const lastOnly = model.sources.find((s) => s.valueCalcId === "last");
  assert.ok(everyCast && lastOnly);

  assert.equal(everyCast.castShare, 1);
  assert.equal(everyCast.instancesPerCast, 1);

  // One press is four casts, so the gated part is worth a quarter of a cast.
  assert.equal(lastOnly.castShare, 0.25);
  assert.equal(lastOnly.instancesPerCast, 0.25);
});

test("a spell cast once per press is unaffected by the share", () => {
  // `times_to_cast` defaults to 1 and almost every spell leaves it there, so dividing by it
  // must be a no-op — including for a part that does carry the gate.
  const model = modelOfConfigured(
    { on_cast: [part([damageAct("once")], [{ type: "is_first_cast", map: {} }], [aoe(3)])] },
    {},
  );
  assert.equal(model.sources[0]?.castShare, 1);
  assert.equal(model.sources[0]?.instancesPerCast, 1);
});