/**
 * The flight, and what it reaches.
 *
 * These are properties rather than magic numbers wherever a property says the same thing: a
 * simulation pinned to fifteen decimal places is a test of the arithmetic's last bit rather
 * than of the behaviour, and it would have to be rewritten the first time anything is made more
 * faithful. The exceptions are the cases where the game's own rule gives an exact answer —
 * a projectile with no motion at all, a nova's spread — and those are pinned hard.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PLACEMENT, coverageOf } from "./geometry.js";
import type { Carrier, DamageSource, ProjectileMotion, SpawnStep } from "./skill-model.js";

function motion(overrides: Partial<ProjectileMotion> = {}): ProjectileMotion {
  return {
    speed: 0.25,
    acceleration: 0,
    yawVelocity: 0,
    yawAcceleration: 0,
    nova: false,
    barrage: false,
    apartDegrees: 75,
    expiresOnEntityHit: true,
    orbitsCaster: false,
    orbitRadius: 0,
    orbitSpeed: 0,
    tracksEnemies: false,
    gravity: false,
    ...overrides,
  };
}

/**
 * A source carried straight off `on_cast`, which is the chain `skillModel` builds for one: empty
 * for a direct act, and one step holding the carrier itself for anything the cast spawns.
 */
function source(overrides: Partial<DamageSource> & { carrier: Carrier }): DamageSource {
  const firesPerCarrier = overrides.firesPerCarrier ?? 1;
  const carriersPerCast = overrides.carriersPerCast ?? overrides.carrier.count;
  const chain: SpawnStep[] =
    overrides.carrier.kind === "direct"
      ? []
      : [
          {
            carrier: overrides.carrier,
            spawnedOn: { kind: "on_cast" },
            from: { kind: "parent" },
            count: overrides.carrier.count,
            scatter: { x: 0, z: 0 },
            ringRadius: 0,
          },
        ];
  return {
    id: "test#0",
    path: ["on cast"],
    valueCalcId: "test",
    element: "Fire",
    trigger: { kind: "on_cast" },
    target: { kind: "aoe", radius: 2, selectionChance: 1 },
    origin: { chain, atTarget: false },
    requires: [],
    firesPerCarrier,
    carriersPerCast,
    instancesPerCast: carriersPerCast * firesPerCarrier,
    disableKnockback: false,
    ...overrides,
  } as DamageSource;
}

const DIRECT: Carrier = { kind: "direct", count: 1, lifeTicks: 0 };

test("an on_cast area hits a target inside it and misses one outside", () => {
  const s = source({ carrier: DIRECT, target: { kind: "aoe", radius: 2, selectionChance: 1 } });

  assert.equal(coverageOf(s, { ...DEFAULT_PLACEMENT, distance: 1 }).hitsPerCast, 1);
  // The test is against the target's hitbox, not its centre: 2.2 is outside a radius of 2 for
  // a point but inside it for something 0.3 wide.
  assert.equal(coverageOf(s, { ...DEFAULT_PLACEMENT, distance: 2.2 }).hitsPerCast, 1);
  assert.equal(coverageOf(s, { ...DEFAULT_PLACEMENT, distance: 2.4 }).hitsPerCast, 0);
});

test("a self-targeted source is never damage to an enemy", () => {
  const s = source({ carrier: DIRECT, target: { kind: "self" } });
  const coverage = coverageOf(s, DEFAULT_PLACEMENT);
  assert.equal(coverage.hitsPerCast, 0);
  assert.match(coverage.note ?? "", /caster/);
});

test("a named-target selector does not care where the target stands", () => {
  const s = source({ carrier: DIRECT, target: { kind: "target" } });
  assert.equal(coverageOf(s, { ...DEFAULT_PLACEMENT, distance: 40 }).hitsPerCast, 1);
});

test("a stationary carrier is all-or-nothing over its whole life, and says so", () => {
  const carrier: Carrier = { kind: "summon_block", count: 1, lifeTicks: 200, falling: false };
  const s = source({ carrier, firesPerCarrier: 10, trigger: { kind: "tick", rate: 20, firstTick: 0 } });

  const inside = coverageOf(s, { ...DEFAULT_PLACEMENT, distance: 1 });
  assert.equal(inside.hitsPerCast, 10);
  assert.equal(inside.method, "stationary");
  assert.match(inside.note ?? "", /stays in the area/);

  assert.equal(coverageOf(s, { ...DEFAULT_PLACEMENT, distance: 10 }).hitsPerCast, 0);
});

test("a motionless projectile pulses on the caster, so a target in range takes every pulse", () => {
  // `proj_speed: 0` with no acceleration: the entity never leaves the caster's feet, which is
  // how the pack builds several ground effects. All six that carry damage — `quake`,
  // `blessed_hammer`, `frost_orbs` — set `expire_on_en_hit: false`, because otherwise the first
  // enemy to walk into the caster would delete the effect.
  const carrier: Carrier = {
    kind: "projectile",
    count: 1,
    baseCount: 1,
    bonusCount: 0,
    lifeTicks: 60,
    motion: motion({ speed: 0, expiresOnEntityHit: false }),
  };
  const s = source({ carrier, firesPerCarrier: 15, trigger: { kind: "tick", rate: 4, firstTick: 0 } });

  const coverage = coverageOf(s, { ...DEFAULT_PLACEMENT, distance: 1 });
  assert.equal(coverage.hitsPerCast, 15);
  assert.equal(coverage.method, "flight");
});

test("a projectile that expires on contact stops pulsing when it reaches the target", () => {
  // `getOrDefault(EXPIRE_ON_ENTITY_HIT, true)`: `SimpleProjectileEntity.onImpact` removes it,
  // so its declared `life_ticks` is a ceiling rather than a schedule. The same projectile that
  // pulses fifteen times when it opts out pulses once when it does not.
  const base = { kind: "projectile", count: 1, baseCount: 1, bonusCount: 0, lifeTicks: 60 } as const;
  const expiring = source({
    carrier: { ...base, motion: motion({ speed: 0, expiresOnEntityHit: true }) },
    firesPerCarrier: 15,
    trigger: { kind: "tick", rate: 4, firstTick: 0 },
  });

  // Standing on it — inside `hitbox + 0.3`, so 0.6 for a 0.3-wide mob — deletes it on tick 1,
  // three ticks before its first pulse would have gone out.
  assert.equal(coverageOf(expiring, { ...DEFAULT_PLACEMENT, distance: 0.5 }).hitsPerCast, 0);
  // A step further out nothing touches it, so all fifteen pulses are delivered — and the target
  // is still inside the radius-2 area they resolve in.
  assert.equal(coverageOf(expiring, { ...DEFAULT_PLACEMENT, distance: 0.7 }).hitsPerCast, 15);
});

test("a nova spreads projectiles evenly, so a single target catches a fraction of them", () => {
  const carrier: Carrier = {
    kind: "projectile",
    count: 8,
    baseCount: 8,
    bonusCount: 0,
    lifeTicks: 40,
    motion: motion({ speed: 0.5, nova: true }),
  };
  const s = source({ carrier, trigger: { kind: "on_hit" }, target: { kind: "aoe", radius: 2, selectionChance: 1 } });

  const coverage = coverageOf(s, { ...DEFAULT_PLACEMENT, distance: 6 });
  // Eight projectiles at 45° apart flying straight out: one is aimed at the target and the
  // rest are not. Counting all eight would be the shotgun assumption this replaces.
  assert.ok(coverage.hitsPerCast >= 1, "the one aimed at the target reaches it");
  assert.ok(coverage.hitsPerCast < 8, "the other seven fly elsewhere");
  assert.equal(coverage.method, "flight");
});

test("a turning projectile stays near the caster, and coverage falls off with distance", () => {
  // `raging_dragon`'s shape: slow, accelerating, and turning hard enough to spiral.
  const carrier: Carrier = {
    kind: "projectile",
    count: 9,
    baseCount: 1,
    bonusCount: 8,
    lifeTicks: 60,
    motion: motion({ speed: 0.15, acceleration: 0.025, yawVelocity: 23.7947, nova: true, expiresOnEntityHit: false }),
  };
  const s = source({ carrier, firesPerCarrier: 15, trigger: { kind: "tick", rate: 4, firstTick: 0 } });

  const at = (distance: number): number => coverageOf(s, { ...DEFAULT_PLACEMENT, distance }).hitsPerCast;

  const near = at(1);
  const mid = at(3);
  const far = at(8);

  assert.ok(near > mid, "a closer target is caught by more pulses");
  assert.ok(mid > far, "and a distant one by fewer");
  assert.equal(far, 0, "the spiral never reaches 8 blocks in 3 seconds at this speed");
  assert.ok(near < s.instancesPerCast, "even point blank, a spread of nine is never all on one target");
});

test("slowing the projectiles tightens the spiral, which is what the support gem is for", () => {
  const build = (speedMulti: number): DamageSource => {
    const carrier: Carrier = {
      kind: "projectile",
      count: 9,
      baseCount: 1,
      bonusCount: 8,
      lifeTicks: 60,
      motion: motion({
        speed: 0.25 * speedMulti,
        acceleration: 0.025,
        yawVelocity: 23.7947,
        nova: true,
        expiresOnEntityHit: false,
      }),
    };
    return source({ carrier, firesPerCarrier: 15, trigger: { kind: "tick", rate: 4, firstTick: 0 } });
  };

  const placement = { ...DEFAULT_PLACEMENT, distance: 2 };
  const normal = coverageOf(build(1), placement).hitsPerCast;
  const slowed = coverageOf(build(0.6), placement).hitsPerCast;

  // `reduced_proj_speed` is -40% `faster_projectiles`. It reads as a downside on the gem, and
  // for a spell whose projectiles orbit you it is the opposite.
  assert.ok(slowed > normal, `slowing should keep more pulses on a near target (${slowed} vs ${normal})`);
});

test("a homing projectile is reported as assumed, not silently flown", () => {
  const carrier: Carrier = {
    kind: "projectile",
    count: 3,
    baseCount: 3,
    bonusCount: 0,
    lifeTicks: 60,
    motion: motion({ tracksEnemies: true }),
  };
  const s = source({ carrier, trigger: { kind: "on_hit" } });

  const coverage = coverageOf(s, { ...DEFAULT_PLACEMENT, distance: 12 });
  assert.equal(coverage.hitsPerCast, 3);
  assert.equal(coverage.method, "assumed");
  assert.match(coverage.note ?? "", /homing/);
});

test("coverage never exceeds the instances the cast produces", () => {
  const carrier: Carrier = {
    kind: "projectile",
    count: 2,
    baseCount: 2,
    bonusCount: 0,
    lifeTicks: 20,
    motion: motion({ speed: 0 }),
  };
  const s = source({ carrier, firesPerCarrier: 4, trigger: { kind: "tick", rate: 5, firstTick: 0 } });

  const coverage = coverageOf(s, { ...DEFAULT_PLACEMENT, distance: 0 });
  assert.equal(s.instancesPerCast, 8);
  assert.ok(coverage.hitsPerCast <= 8);
  assert.equal(coverage.fraction, coverage.hitsPerCast / 8);
});


// ---------------------------------------------------------------------------
// The origin chain
// ---------------------------------------------------------------------------

/** A source riding `chain`, the shape `skillModel` produces for a nested carrier. */
function chained(chain: SpawnStep[], overrides: Partial<DamageSource> = {}): DamageSource {
  const carrier = chain[chain.length - 1]!.carrier;
  const firesPerCarrier = overrides.firesPerCarrier ?? 1;
  const carriersPerCast = overrides.carriersPerCast ?? chain.reduce((n, step) => n * step.count, 1);
  return {
    id: "test#0",
    path: ["on cast"],
    valueCalcId: "test",
    element: "Fire",
    carrier,
    trigger: { kind: "expire" },
    target: { kind: "aoe", radius: 1, selectionChance: 1 },
    origin: { chain, atTarget: false },
    requires: [],
    firesPerCarrier,
    carriersPerCast,
    instancesPerCast: carriersPerCast * firesPerCarrier,
    disableKnockback: false,
    ...overrides,
  } as DamageSource;
}

function step(carrier: Carrier, overrides: Partial<SpawnStep> = {}): SpawnStep {
  return {
    carrier,
    spawnedOn: { kind: "on_cast" },
    from: { kind: "parent" },
    count: carrier.count,
    scatter: { x: 0, z: 0 },
    ringRadius: 0,
    ...overrides,
  };
}

const block = (lifeTicks: number): Carrier => ({
  kind: "summon_block",
  count: 1,
  lifeTicks,
  falling: false,
});

test("a block spawned by a projectile sits where the projectile was, not at the caster", () => {
  // `onExpire` sets the source entity to the carrier, so `SummonBlockAction.findPositions`
  // centres on the projectile. A radius-1 ground effect laid down four blocks out reaches a
  // target four blocks out and nothing at the caster's feet.
  const bolt: Carrier = {
    kind: "projectile",
    count: 1,
    baseCount: 1,
    bonusCount: 0,
    lifeTicks: 4,
    motion: motion({ speed: 1, expiresOnEntityHit: false }),
  };
  const s = chained([step(bolt), step(block(20), { spawnedOn: { kind: "expire" } })]);

  // Four ticks at a block a tick, minus the 0.99 drag: just under four blocks out.
  assert.equal(coverageOf(s, { ...DEFAULT_PLACEMENT, distance: 4 }).hitsPerCast, 1);
  assert.equal(coverageOf(s, { ...DEFAULT_PLACEMENT, distance: 0 }).hitsPerCast, 0);
});

test("a scattered summon lands the share of its box that reaches, not all or nothing", () => {
  // `SummonBlockAction.getRandomOffset` is uniform on [-offset, +offset] per axis, so the
  // expected hits are the area of the reaching disc over the area of the box:
  // π × 1.3² / 4² = 0.332.
  const s = chained([step(block(1), { scatter: { x: 2, z: 2 } })], {
    target: { kind: "aoe", radius: 1, selectionChance: 1 },
  });

  const coverage = coverageOf(s, { ...DEFAULT_PLACEMENT, distance: 0 });
  assert.equal(coverage.method, "stationary");
  const expected = (Math.PI * 1.3 * 1.3) / 16;
  assert.ok(
    Math.abs(coverage.hitsPerCast - expected) < 0.03,
    `expected about ${expected.toFixed(3)}, got ${coverage.hitsPerCast.toFixed(3)}`,
  );
});

test("a fast projectile cannot step over a target standing between its tick samples", () => {
  // `AbstractArrow.tick` clips from the old position to the new one, so the hit is against the
  // movement. At three blocks a tick the samples are at 3 and 6; a target at 4.5 is between
  // them and a point test would miss it entirely.
  const fast: Carrier = {
    kind: "projectile",
    count: 1,
    baseCount: 1,
    bonusCount: 0,
    lifeTicks: 10,
    motion: motion({ speed: 3, expiresOnEntityHit: true }),
  };
  const s = chained([step(fast)], { trigger: { kind: "on_hit" } });

  assert.equal(coverageOf(s, { ...DEFAULT_PLACEMENT, distance: 4.5 }).hitsPerCast, 1);
});

test("a projectile that expires on the target drops its payload on the target", () => {
  // `moveToImpactPosition` clips against `hitbox.inflate(0.3)`, so the projectile comes to rest
  // 0.6 blocks from a 0.3-wide mob — near enough for even a small ground effect to cover it.
  // Taking the tick sample instead would leave it a whole step short.
  const bolt: Carrier = {
    kind: "projectile",
    count: 1,
    baseCount: 1,
    bonusCount: 0,
    lifeTicks: 100,
    motion: motion({ speed: 1, expiresOnEntityHit: true }),
  };
  const s = chained([step(bolt), step(block(20), { spawnedOn: { kind: "expire" } })], {
    target: { kind: "aoe", radius: 0.5, selectionChance: 1 },
  });

  for (const distance of [2, 3, 5, 8, 12]) {
    assert.equal(
      coverageOf(s, { ...DEFAULT_PLACEMENT, distance }).hitsPerCast,
      1,
      `a wall laid on the target should reach it at ${distance} blocks`,
    );
  }
});

test("a hit that never happens spawns nothing at the target", () => {
  // The `PositionSource.TARGET` step carries the gate that put it there: no hit, no carrier, and
  // therefore no damage — rather than a shard conjured onto a mob the spell never touched.
  const bolt: Carrier = {
    kind: "projectile",
    count: 1,
    baseCount: 1,
    bonusCount: 0,
    lifeTicks: 3,
    motion: motion({ speed: 1, expiresOnEntityHit: false }),
  };
  const shard: Carrier = {
    kind: "projectile",
    count: 4,
    baseCount: 4,
    bonusCount: 0,
    lifeTicks: 6,
    motion: motion({ speed: 0.5, nova: true, expiresOnEntityHit: false }),
  };
  const s = chained(
    [
      step(bolt),
      step(shard, {
        spawnedOn: { kind: "on_hit" },
        from: { kind: "target", gate: { kind: "aoe", radius: 1, selectionChance: 1 } },
      }),
    ],
    { trigger: { kind: "on_hit" } },
  );

  // Within the three blocks the bolt travels, the shards go out and come back on their targets.
  assert.ok(coverageOf(s, { ...DEFAULT_PLACEMENT, distance: 2 }).hitsPerCast > 0);
  // Beyond it nothing was ever hit, so nothing was ever spawned.
  assert.equal(coverageOf(s, { ...DEFAULT_PLACEMENT, distance: 9 }).hitsPerCast, 0);
});
