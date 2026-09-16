/**
 * How much of a cast reaches the enemy you care about.
 *
 * `skill-model.ts` says a cast of `raging_dragon` produces 136 damage instances: one slam and
 * nine projectiles that each pulse fifteen times. It deliberately does not say how many of
 * those land on one enemy, because that is not in the data — it is where the projectiles fly
 * and where the enemy is standing.
 *
 * This file answers it the only honest way available offline: by flying the projectile. Every
 * number the game uses to move a `SimpleProjectileEntity` is in the spell JSON, so the flight
 * is reproducible to the tick, and the only thing that has to be supplied from outside is
 * where the target stands. That makes the coverage figure a *derivation with one input* rather
 * than a guess, and it makes the support gems behave: `reduced_proj_speed` gives -40%
 * `faster_projectiles`, which tightens the dragons' spiral so more of their pulses stay on top
 * of a nearby enemy, and `plus_aoe` widens the radius each pulse checks.
 *
 * ## The flight, tick by tick
 *
 * `SimpleProjectileEntity.tick()` is `super.tick()` then `onTick()`, in that order, and the
 * component that deals damage runs at the end of `onTick()`. So within one tick:
 *
 *   1. vanilla `AbstractArrow.tick` increments `tickCount`, moves the entity by its current
 *      velocity, then scales that velocity by the 0.99 air inertia (and subtracts 0.05 from y
 *      when the projectile has gravity, which these mostly do not);
 *   2. `applyAcceleration()` re-sets the speed to `max(speed + proj_accel, 0)`, keeping the
 *      direction — so `proj_accel` fights the drag rather than adding to it;
 *   3. `applyYawVelocity()` adds `yaw_acceleration` to the running yaw velocity and rotates the
 *      velocity that many degrees about the projectile's **up** vector;
 *   4. the components fire, at the position step 1 left the projectile in.
 *
 * Positions are therefore sampled after the move and before the next one, which is what makes
 * `tickCount % tick_rate` line up with a real place in the world.
 *
 * ## Where the projectiles start pointing
 *
 * `ProjectileCastHelper.cast()` decides that, and the spread mode is the interesting part:
 *
 *   - `NOVA` (`SPREAD_OUT_CIRCLE`) puts projectile `i` at `i * 360 / n` degrees of yaw and
 *     forces pitch to 0, so a nova is always a flat ring regardless of where you were looking;
 *   - `BARRAGE` (`SPREAD_OUT_HORIZONTAL`) keeps the direction and offsets each projectile one
 *     block sideways;
 *   - otherwise they fan across `proj_apart` degrees, `offset * apart / n` each.
 *
 * ## Where a carrier starts — walking the origin chain
 *
 * A flight has to start somewhere, and for most of this pack that somewhere is not the caster.
 * `DamageSource.origin` carries the chain `skill-model.ts` resolved — every carrier between the
 * caster and the act, each with the trigger that spawned it and where it was placed — and
 * `resolveSites` walks it:
 *
 *   - a **projectile** step turns each parent position into `count` integrated flights;
 *   - a **stationary** step (`summon_block`, `summon_at_sight`) takes the parent's position at
 *     the tick the spawning part fired, adds `ringPos` spread and the `random_x/z_offset`
 *     scatter, and stays there;
 *   - a step placed **at sight** starts at the crosshair, which for an aimed cast is the target,
 *     capped at the act's `distance`;
 *   - a step placed **at the target** starts on the mob — and only happens at all if whatever
 *     spawned it actually reached that mob, which is the gate the step carries.
 *
 * `fire_wall` is the case that makes it matter: its walls are laid down by five projectiles when
 * they expire, so they sit wherever those projectiles got to. Placed at the caster's feet — the
 * old assumption — a radius-0.5 wall reaches nothing at all and the spell reports zero.
 *
 * Scatter is integrated rather than rolled. A `random_x_offset` of 2 means the block lands
 * uniformly anywhere in a 4×4 box, so the honest answer is the *expected* number of hits over
 * that box: the sites are a midpoint grid across it, each weighted by its share.
 *
 * ## What is still assumed, and says so
 *
 * A homing projectile (`tracks_enemies`) steers at a target this file has no simulation for, so
 * it is reported as reaching its target rather than flown, and the `Coverage.method` says
 * `assumed`. Stationary carriers — summoned blocks, ground effects — are a containment test,
 * not a flight. Both are labelled, so a number that came from an assumption never looks like
 * one that came from a simulation.
 *
 * Three details of placement are deliberately not modelled, all of them terrain: `find_surface`
 * snaps a summoned block to the ground, `asBlockPos` truncates it to integer coordinates, and a
 * gravity projectile stops where it meets the floor. All three move a carrier vertically or by
 * less than a block, and none of them can be answered without the world the fight happens in.
 */

import type { TargetPlacement } from "@cte2/schema";

import type {
  Carrier,
  DamageSource,
  ProjectileMotion,
  SourceTarget,
  SpawnStep,
  Trigger,
} from "./skill-model.js";

export type { TargetPlacement };

const DEG = Math.PI / 180;

/** Vanilla `AbstractArrow`'s air inertia, applied to the velocity after every move. */
const AIR_INERTIA = 0.99;

/** Below this, `SimpleProjectileEntity.setSpeed` treats the velocity as having no direction. */
const MIN_SPEED = 1e-4;

/**
 * How much wider than its own hitbox a mob is, for a projectile flying at it.
 *
 * `SimpleProjectileEntity.findHitEntity` hands `getBoundingBox().expandTowards(motion).inflate(1)`
 * to `ProjectileUtil.getEntityHitResult`, and that box is only the broadphase — the test that
 * decides the hit is `entity.getBoundingBox().inflate(0.3F).clip(from, to)`, and
 * `moveToImpactPosition` then places the projectile on that same box. So one number answers both
 * "did it hit" and "where did it stop", and it is 0.3 rather than the pick radius.
 */
const HITBOX_INFLATE = 0.3;

/** A cap on how long a flight is integrated, so a 12000-tick totem cannot stall a UI thread. */
const MAX_SIMULATED_TICKS = 2400;

/**
 * Melee range against a player-sized mob directly in front of you — the situation a weapon
 * skill is used in, and the only thing here a build document has to state rather than derive.
 */
export const DEFAULT_PLACEMENT: TargetPlacement = {
  distance: 2,
  radius: 0.3,
  bearing: 0,
  height: 1,
};

export type CoverageMethod =
  /** An `on_cast` act resolved around the caster — a containment test, exact. */
  | "direct"
  /** The projectile's own flight was integrated tick by tick. */
  | "flight"
  /** `orbits_caster`: position is analytic rather than integrated. */
  | "orbit"
  /** A carrier that does not move; the target either stands in it or does not. */
  | "stationary"
  /** Something the simulation cannot resolve. `note` says what. */
  | "assumed";

export type Coverage = {
  /** How many of this source's instances land on the target, per cast. */
  hitsPerCast: number;
  /** `hitsPerCast / instancesPerCast`, for display. NaN-free: 0 when nothing fires. */
  fraction: number;
  method: CoverageMethod;
  /**
   * *When* each of those hits lands, as ticks after the cast.
   *
   * A cast is not an instant: `raging_dragon`'s dragons deliver their pulses across a full
   * three seconds, so a cast fired every half second has six of them in the air at once and the
   * damage a target has actually taken by second one is nothing like a sixth of the sustained
   * rate. Sustained DPS does not care — a cast's whole output is amortised over the cast
   * interval either way — but a short fight does, and so does a ramp.
   *
   * Repeated entries are real: two projectiles landing on the same tick appear twice.
   */
  landedTicks: number[];
  /** Set when the answer rests on something other than the simulation. */
  note?: string;
};

/**
 * How many of one damage source's instances reach the target.
 *
 * `instancesPerCast` on the source is the ceiling; this returns how much of it lands.
 */
export function coverageOf(source: DamageSource, placement: TargetPlacement): Coverage {
  const result = compute(source, placement);
  const ceiling = source.instancesPerCast;
  const hits = Math.min(result.hitsPerCast, ceiling);
  return {
    ...result,
    hitsPerCast: hits,
    fraction: ceiling > 0 ? hits / ceiling : 0,
    landedTicks: result.landedTicks.slice().sort((a, b) => a - b),
  };
}

function compute(source: DamageSource, placement: TargetPlacement): Coverage {
  const { carrier, target } = source;

  // A selector that names the target outright does not care where it stands.
  if (target.kind === "target") {
    return {
      hitsPerCast: source.instancesPerCast,
      fraction: 1,
      method: "direct",
      landedTicks: firingTicks(source),
    };
  }
  // `self` heals or buffs the caster; it is not damage to the enemy.
  if (target.kind === "self" || target.kind === "none") {
    return {
      hitsPerCast: 0,
      fraction: 0,
      method: "direct",
      landedTicks: [],
      note: "targets the caster, not an enemy",
    };
  }

  // `selection_chance` is a per-entity roll inside `AoeSelector`, so it scales every count here.
  const chance = target.kind === "aoe" ? target.selectionChance : 1;

  if (carrier.kind === "projectile" && carrier.motion.tracksEnemies) {
    return {
      hitsPerCast: source.instancesPerCast * chance,
      fraction: 0,
      method: "assumed",
      landedTicks: firingTicks(source),
      note: "homing: assumed to reach the target, because its steering is not simulated",
    };
  }

  const resolved = resolveSites(source, placement);
  const method = methodOf(source);
  if (resolved.sites.length === 0) {
    return {
      hitsPerCast: 0,
      fraction: 0,
      method,
      landedTicks: [],
      note: resolved.note ?? "nothing this cast spawns ever reaches the target",
    };
  }

  const targetPos = targetPosition(placement);

  let hits = 0;
  const landedTicks: number[] = [];
  const land = (tick: number, weight: number): void => {
    hits += weight;
    landedTicks.push(tick);
  };

  for (const site of resolved.sites) {
    if (source.trigger.kind === "on_hit") {
      // `SpellCtx.onHit` runs when the carrier touches an enemy and resolves at that enemy, so
      // for a projectile the whole question is whether its flight passes through the hitbox,
      // and for a ground effect whether the target is standing in it.
      if (site.path !== undefined) {
        const hit = hitTick(site, placement, targetPos);
        if (hit !== undefined && hit.tick <= site.endsAt) {
          land(site.bornAt + hit.tick, site.weight * chance);
        }
      } else if (reachesFrom(site.at, source, placement)) {
        land(site.bornAt, site.weight * chance);
      }
      continue;
    }

    for (const tick of firesOn(source.trigger, carrier, site.endsAt)) {
      const at = positionAt(site, carrier, tick);
      if (at !== undefined && reachesFrom(at, source, placement)) {
        land(site.bornAt + tick, site.weight * chance);
      }
    }
  }

  const note = resolved.note ?? coverageNote(method, source, hits);
  return {
    hitsPerCast: hits,
    fraction: 0,
    method,
    landedTicks: sample(landedTicks, MAX_LANDED_TICKS),
    ...(note === undefined ? {} : { note }),
  };
}

/**
 * What the number rests on beyond the simulation, in one line.
 *
 * A ground effect is the case that needs saying: whether a mob walks out of a fire that burns
 * for eight seconds is behaviour, not data, so the count assumes it does not.
 */
function coverageNote(
  method: CoverageMethod,
  source: DamageSource,
  hits: number,
): string | undefined {
  if (hits <= 0) {
    if (method === "direct") return "the target stands outside the area this resolves in";
    if (method === "stationary") return "the target stands outside the area this is summoned in";
    return undefined;
  }
  if (method === "stationary" && source.trigger.kind === "tick") {
    return "assumes the target stays in the area for its whole duration";
  }
  return undefined;
}

/** What kind of derivation the answer rests on, for `Coverage.method`. */
function methodOf(source: DamageSource): CoverageMethod {
  switch (source.carrier.kind) {
    case "direct":
      return "direct";
    case "projectile":
      return source.carrier.motion.orbitsCaster ? "orbit" : "flight";
    default:
      return "stationary";
  }
}

/**
 * The ticks of its own life a carrier fires this trigger on, given when that life actually ends.
 *
 * `endsAt` is not always `lifeTicks`: `getOrDefault(EXPIRE_ON_ENTITY_HIT, true)` means most
 * projectiles are deleted by the first enemy they touch, which both cuts their tick pulses
 * short and brings their expire forward — and moves it onto the target, which is where
 * `fire_wall`'s walls are really laid down.
 *
 * A direct act has no carrier entity, so a tick gate falls back to the caster's own unsynced
 * `tickCount` and the only honest schedule is "with the cast"; `firesFor` already turned that
 * into the `1/rate` expectation, so the count is not repeated here.
 */
function firesOn(trigger: Trigger, carrier: Carrier, endsAt: number): number[] {
  if (trigger.kind === "on_cast") return [0];
  if (trigger.kind === "expire") return [endsAt];
  if (trigger.kind === "on_hit") return [0];
  if (carrier.kind === "direct") return [0];
  return tickIndices(trigger, endsAt);
}

/**
 * The ticks a source fires on, for a carrier whose position never has to be checked.
 *
 * Used where coverage is all-or-nothing — a selector that names the target, a homing projectile
 * credited with reaching it — so the *count* was already settled and only the timing is wanted.
 */
function firingTicks(source: DamageSource): number[] {
  if (source.trigger.kind !== "tick") return [0];
  const ticks = tickIndices(source.trigger, source.carrier.lifeTicks);
  if (source.carrier.kind === "direct" || ticks.length === 0) return [0];
  const out: number[] = [];
  for (let i = 0; i < source.carriersPerCast; i++) out.push(...ticks);
  return sample(out, MAX_LANDED_TICKS);
}

// ---------------------------------------------------------------------------
// The origin chain
// ---------------------------------------------------------------------------

/**
 * One carrier of this source, placed.
 *
 * `weight` is the fraction of a whole carrier this entry stands for: a scattered summon is a
 * grid of sites sharing one carrier's worth between them, so the hits they produce add up to
 * the expected number rather than to the number of samples.
 */
type Site = {
  /** Where a stationary carrier sits, or where a projectile was launched from. */
  at: Point;
  /** Ticks after the cast at which this carrier came into existence. */
  bornAt: number;
  /** A projectile's position after every tick of its life; index `t - 1` is `tickCount === t`. */
  path?: Point[];
  /**
   * The tick of this carrier's *own* life at which it stops existing.
   *
   * `lifeTicks` for anything that runs its course, and the tick it reached the target for a
   * projectile with `expire_on_en_hit` — which is the default, so it is the common case.
   */
  endsAt: number;
  /**
   * Where a carrier stopped, when something stopped it before its life ran out.
   *
   * Only a projectile deleted by an entity hit has one, and it is the position
   * `moveToImpactPosition` left it in rather than the position its last tick of movement would
   * have — which is what its `on_entity_expire` parts then resolve against.
   */
  restingAt?: Point;
  weight: number;
};

/** A ceiling on sites carried between steps, so a deep chain cannot stall a UI thread. */
const MAX_SITES = 3000;

/** A ceiling on the landing schedule, which `damageWithin` uses for its shape, not its length. */
const MAX_LANDED_TICKS = 2000;

/** How wide one cell of the scatter integration is, in blocks, and how many cells are allowed. */
const SCATTER_CELL = 0.25;
const MAX_SCATTER_SAMPLES = 21;

/**
 * Every carrier of this source, placed, by walking `origin.chain` outward from the caster.
 *
 * Each step spawns from the previous one at the ticks the spawning part fired on — expire at
 * the end of its parent's life, a tick gate on its parent's own `tickCount` — which is what
 * puts `armageddon`'s meteors along the block's fifteen ticks and `fire_wall`'s walls at the
 * five places its projectiles ran out.
 */
function resolveSites(
  source: DamageSource,
  placement: TargetPlacement,
): { sites: Site[]; note?: string } {
  const target = targetPosition(placement);
  let sites: Site[] = [{ at: { x: 0, z: 0 }, bornAt: 0, endsAt: 0, weight: 1 }];
  let parent: Carrier = { kind: "direct", count: 1, lifeTicks: 0 };
  let note: string | undefined;
  let truncated = false;

  for (const step of source.origin.chain) {
    const next: Site[] = [];
    const scatter = scatterOffsets(step);

    // Thin *before* expanding, not after: a step that multiplies by its count and again by its
    // scatter grid would otherwise build the whole product — up to tens of thousands of flights
    // — before anything capped it. Each survivor carries the weight of the ones it stands in for.
    const fanOut = Math.max(1, step.count * scatter.length);
    if (sites.length * fanOut > MAX_SITES) {
      const kept = sample(sites, Math.max(1, Math.floor(MAX_SITES / fanOut)));
      const scale = sites.length / kept.length;
      sites = kept.map((s) => ({ ...s, weight: s.weight * scale }));
      truncated = true;
    }

    for (const site of sites) {
      // Where the spawning act ran, and when. A `TARGET` placement only happens if whatever was
      // spawning actually found the target, so the gate is checked before the site is made.
      for (const launch of launchPoints(site, step, parent, placement, target)) {
        for (let i = 0; i < step.count; i++) {
          const ring = ringOffset(step, i);
          for (const offset of scatter) {
            const at = { x: launch.at.x + ring.x + offset.x, z: launch.at.z + ring.z + offset.z };
            const weight = site.weight * launch.weight * offset.weight;
            const path =
              step.carrier.kind === "projectile" ? flightFrom(step.carrier, at, i) : undefined;
            const spawned: Site = {
              at,
              bornAt: launch.tick,
              endsAt: step.carrier.lifeTicks,
              weight,
              ...(path === undefined ? {} : { path }),
            };
            const life = lifeOf(step.carrier, spawned, placement, target);
            spawned.endsAt = life.endsAt;
            if (life.restingAt !== undefined) spawned.restingAt = life.restingAt;
            next.push(spawned);
          }
        }
      }
    }

    sites = next;
    parent = step.carrier;
  }

  if (truncated) {
    note = "a chain this wide was sampled rather than enumerated, so the count is an estimate";
  } else if (source.origin.chain.some((s) => s.from.kind === "sight")) {
    // `Entity.pick` clips against **blocks**, not entities, so where the crosshair lands is a
    // fact about the terrain rather than about the mob. Aiming down at something in front of you
    // puts it at that thing's feet, which is what this assumes and cannot verify.
    note = "assumes you are aiming at the target: a summon at sight lands where the crosshair "
      + "meets the ground, which is terrain rather than data";
  }
  return { sites, ...(note === undefined ? {} : { note }) };
}

/**
 * The tick of its own life at which one carrier stops existing.
 *
 * `SimpleProjectileEntity.onImpact` removes the projectile on an entity hit unless
 * `EXPIRE_ON_ENTITY_HIT` is false, and the field defaults to **true** — so a projectile aimed at
 * something in range usually dies on it rather than flying out its declared lifespan. That is
 * what decides when its `on_entity_expire` parts run, and where.
 */
function lifeOf(
  carrier: Carrier,
  site: Site,
  placement: TargetPlacement,
  target: Point,
): { endsAt: number; restingAt?: Point } {
  if (carrier.kind !== "projectile" || site.path === undefined) return { endsAt: carrier.lifeTicks };
  if (!carrier.motion.expiresOnEntityHit) return { endsAt: carrier.lifeTicks };
  const hit = hitTick(site, placement, target);
  if (hit === undefined || hit.tick > carrier.lifeTicks) return { endsAt: carrier.lifeTicks };
  return { endsAt: hit.tick, restingAt: hit.at };
}

/** Where and when one spawning activation happened, given the carrier it spawned from. */
function launchPoints(
  site: Site,
  step: SpawnStep,
  parent: Carrier,
  placement: TargetPlacement,
  target: Point,
): { at: Point; tick: number; weight: number }[] {
  // `SummonAtSightAction` ray-picks from the caster's eyes: the crosshair is on the target for
  // an aimed cast, and stops short of it when the target is further than the act can reach.
  if (step.from.kind === "sight") {
    const reach = Math.min(step.from.maxDistance, placement.distance);
    const scale = placement.distance > 0 ? reach / placement.distance : 0;
    return [{ at: { x: target.x * scale, z: target.z * scale }, tick: 0, weight: 1 }];
  }

  // `PositionSource.TARGET`: this only runs at all for an enemy the spawner actually reached,
  // and it runs *on* that enemy. An `on_hit` context says the spawner touched it; a
  // `per_entity_hit` block says the outer part's selector picked it.
  if (step.from.kind === "target") {
    if (step.spawnedOn.kind === "on_hit") {
      const hit = hitTick(site, placement, target);
      return hit === undefined ? [] : [{ at: target, tick: site.bornAt + hit.tick, weight: 1 }];
    }
    const out: { at: Point; tick: number; weight: number }[] = [];
    for (const tick of firesOn(step.spawnedOn, parent, site.endsAt)) {
      const at = positionAt(site, parent, tick);
      if (at !== undefined && reaches(at, step.from.gate, placement)) {
        out.push({ at: target, tick: site.bornAt + tick, weight: 1 });
      }
    }
    return out;
  }

  const out: { at: Point; tick: number; weight: number }[] = [];
  for (const tick of firesOn(step.spawnedOn, parent, site.endsAt)) {
    const at = positionAt(site, parent, tick);
    if (at !== undefined) out.push({ at, tick: site.bornAt + tick, weight: 1 });
  }
  return out;
}

/** Where a carrier was on one tick of its own life. A carrier that does not move ignores it. */
function positionAt(site: Site, carrier: Carrier, tick: number): Point | undefined {
  if (carrier.kind === "direct" || site.path === undefined) return site.at;
  if (site.restingAt !== undefined && tick >= site.endsAt) return site.restingAt;
  return site.path[tick - 1];
}

/**
 * When and where a projectile first touched the target, if it ever did.
 *
 * The test is against the *movement*, not against the position the tick ended at:
 * `AbstractArrow.tick` clips from the old position to the new one, so a projectile moving two
 * blocks a tick cannot step over a mob standing between its samples. `rime_reaver`'s shards are
 * the case that needs it — they are spawned inside the mob and move two blocks outward before
 * the first sample, so a point test never sees the hit that spawned them land.
 *
 * `at` is where `moveToImpactPosition` leaves it: the first point of that movement to reach the
 * inflated hitbox. Solving for it rather than taking the tick sample is what keeps a slow
 * projectile and a fast one agreeing about where they stopped, instead of reporting whatever
 * their step size happened to straddle.
 */
function hitTick(
  site: Site,
  placement: TargetPlacement,
  target: Point,
): { tick: number; at: Point } | undefined {
  if (site.path === undefined) return undefined;
  const reach = placement.radius + HITBOX_INFLATE;
  let from = site.at;
  for (let i = 0; i < site.path.length; i++) {
    const to = site.path[i];
    if (to === undefined) break;
    if (gapToSegment(target, from, to) <= reach) {
      return { tick: i + 1, at: approachPoint(from, to, target, reach) };
    }
    from = to;
  }
  return undefined;
}

/**
 * Where along `from → to` the mover first comes within `standoff` of `target`.
 *
 * The segment start when it is already that close, and its closest approach when floating point
 * puts the crossing just outside `[0, 1]` — the caller only asks once the segment is known to
 * reach.
 */
function approachPoint(from: Point, to: Point, target: Point, standoff: number): Point {
  if (horizontalGap(from, target) <= standoff) return from;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const a = dx * dx + dz * dz;
  if (a <= 0) return from;
  const fx = from.x - target.x;
  const fz = from.z - target.z;
  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - standoff * standoff;
  const discriminant = b * b - 4 * a * c;
  if (discriminant >= 0) {
    const t = (-b - Math.sqrt(discriminant)) / (2 * a);
    if (t >= 0 && t <= 1) return { x: from.x + dx * t, z: from.z + dz * t };
  }
  const t = Math.min(1, Math.max(0, -(fx * dx + fz * dz) / a));
  return { x: from.x + dx * t, z: from.z + dz * t };
}

/** How close a point comes to a line segment, in the horizontal plane. */
function gapToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 0) return horizontalGap(point, from);
  const t = ((point.x - from.x) * dx + (point.z - from.z) * dz) / lengthSquared;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return horizontalGap(point, { x: from.x + dx * clamped, z: from.z + dz * clamped });
}

/**
 * `SummonBlockAction.ringPos(center, i, count, casterYRot)`, with the caster facing +Z.
 *
 *     double r = Math.max(RING_SPACING, count * RING_SPACING / (2 * Math.PI));
 *     double a = Math.toRadians(yRot) + i * (2 * Math.PI / count);
 *     return new MyPosition(x + Math.sin(a) * r, y, z + Math.cos(a) * r);
 */
function ringOffset(step: SpawnStep, index: number): Point {
  if (step.count <= 1 || step.ringRadius <= 0) return { x: 0, z: 0 };
  const angle = (index * 2 * Math.PI) / step.count;
  return { x: Math.sin(angle) * step.ringRadius, z: Math.cos(angle) * step.ringRadius };
}

/**
 * A midpoint grid across the `random_x/z_offset` box, each cell carrying its share of one block.
 *
 * `SummonBlockAction.getRandomOffset` is uniform on `[-offset, +offset]`, so integrating the box
 * gives the expected hits; rolling it once would give one sample of a distribution instead.
 */
function scatterOffsets(step: SpawnStep): { x: number; z: number; weight: number }[] {
  const { x: sx, z: sz } = step.scatter;
  if (sx <= 0 && sz <= 0) return [{ x: 0, z: 0, weight: 1 }];
  const cells = (span: number): number =>
    span > 0 ? Math.min(MAX_SCATTER_SAMPLES, Math.max(3, Math.ceil((2 * span) / SCATTER_CELL))) : 1;
  const nx = cells(sx);
  const nz = cells(sz);
  const out: { x: number; z: number; weight: number }[] = [];
  const weight = 1 / (nx * nz);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      out.push({
        x: nx === 1 ? 0 : -sx + (2 * sx * (i + 0.5)) / nx,
        z: nz === 1 ? 0 : -sz + (2 * sz * (j + 0.5)) / nz,
        weight,
      });
    }
  }
  return out;
}

/** One projectile of a mid-chain spawn, launched from `from` on the caster's heading. */
function flightFrom(
  carrier: Extract<Carrier, { kind: "projectile" }>,
  from: Point,
  index: number,
): Point[] {
  const ticks = Math.min(carrier.lifeTicks, MAX_SIMULATED_TICKS);
  const { motion, count } = carrier;
  if (motion.orbitsCaster) return orbitPath(motion, ticks, index, count);
  const path = integrate(motion, ticks, initialYaw(motion, index, count), sidewaysOffset(motion, index, count));
  return path.map((p) => ({ x: p.x + from.x, z: p.z + from.z }));
}

/** Keeps at most `limit` entries, evenly spaced, so a sampled list still has the right shape. */
function sample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  const out: T[] = [];
  const stride = items.length / limit;
  for (let i = 0; i < limit; i++) {
    const item = items[Math.floor(i * stride)];
    if (item !== undefined) out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The flight
// ---------------------------------------------------------------------------

type Point = { x: number; z: number };

/**
 * `ProjectileCastHelper.cast()`'s yaw offset for projectile `i` of `n`.
 *
 *     if (castType == SPREAD_OUT_CIRCLE) { multiProjYawOffset = i * 360f / projectilesAmount; pitch = 0; }
 *     else if (castType == SPREAD_OUT_IN_RADIUS) { multiProjYawOffset = offset * apart / projectilesAmount; }
 *
 * where `offset = i - (n - 1) / 2`. A single projectile gets no offset at all — the branch is
 * guarded on `projectilesAmount > 1` — which is why a nova of one still flies straight ahead.
 */
function initialYaw(motion: ProjectileMotion, i: number, count: number): number {
  if (count <= 1) return 0;
  if (motion.nova) return (i * 360) / count;
  if (motion.barrage) return 0;
  const offset = i - (count - 1) / 2;
  return (offset * motion.apartDegrees) / count;
}

/** `SPREAD_OUT_HORIZONTAL` shifts each projectile one block along the caster's side vector. */
function sidewaysOffset(motion: ProjectileMotion, i: number, count: number): number {
  if (!motion.barrage || count <= 1) return 0;
  return i - (count - 1) / 2;
}

/**
 * Integrates one projectile's flight.
 *
 * The caster stands at the origin facing +Z (yaw 0), which is the frame `targetPosition` places
 * the enemy in. `calculateDirection` with pitch 0 gives a forward of `(-sin yaw, 0, cos yaw)`
 * and an up of `(0, 1, 0)`, so the yaw rotation is about world Y and the whole flight stays in
 * the horizontal plane — which is what a nova is. Pitch only enters for spells that aim, and
 * those are the ones whose y matters, handled by the vertical test in `reachesFrom`.
 */
function integrate(
  motion: ProjectileMotion,
  ticks: number,
  yawDegrees: number,
  sideOffset: number,
): Point[] {
  const yaw = yawDegrees * DEG;
  // `forward.rotateAxis(-yawOffsetRad, up)` about (0,1,0), starting from (0,0,1).
  let vx = -Math.sin(yaw) * motion.speed;
  let vz = Math.cos(yaw) * motion.speed;

  // The side vector at caster yaw 0 is (cos 0, 0, sin 0) = (1, 0, 0).
  let x = sideOffset;
  let z = 0;

  let yawVelocity = motion.yawVelocity;
  const path: Point[] = [];

  for (let t = 1; t <= ticks; t++) {
    // 1. vanilla moves first, then applies drag.
    x += vx;
    z += vz;
    path.push({ x, z });
    vx *= AIR_INERTIA;
    vz *= AIR_INERTIA;

    // 2. `applyAcceleration` — a no-op when proj_accel is 0, so drag is left standing.
    if (motion.acceleration !== 0) {
      const speed = Math.hypot(vx, vz);
      const next = Math.max(speed + motion.acceleration, 0);
      if (speed >= MIN_SPEED) {
        const factor = next / speed;
        vx *= factor;
        vz *= factor;
      } else if (next !== 0) {
        // `setSpeed` falls back to the stored forward vector when the velocity has no direction.
        vx = -Math.sin(yaw) * next;
        vz = Math.cos(yaw) * next;
      }
    }

    // 3. `applyYawVelocity` — acceleration is added *before* the rotation is applied.
    if (yawVelocity !== 0 || motion.yawAcceleration !== 0) {
      yawVelocity += motion.yawAcceleration;
      // `adjustYaw(angle)` rotates by `-angle` about the up vector, which is +Y here.
      const a = -yawVelocity * DEG;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const nx = vx * cos + vz * sin;
      const nz = -vx * sin + vz * cos;
      vx = nx;
      vz = nz;
    }
  }

  return path;
}

/**
 * `applyOrbit` — the projectile is placed on a circle around the caster rather than flown.
 *
 * 6.4.13 only; one spell in this pack uses it. The angle advances by `orbit_speed` a tick from
 * a per-projectile start angle, which for an evenly spread cast is `i * 360 / n`.
 */
function orbitPath(motion: ProjectileMotion, ticks: number, i: number, count: number): Point[] {
  const start = count > 1 ? (i * 360) / count : 0;
  const path: Point[] = [];
  for (let t = 1; t <= ticks; t++) {
    const angle = (start + motion.orbitSpeed * t) * DEG;
    path.push({ x: Math.cos(angle) * motion.orbitRadius, z: Math.sin(angle) * motion.orbitRadius });
  }
  return path;
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

/** The ticks a tick-gated component fires on, over a carrier that lives `lifeTicks` ticks. */
function tickIndices(trigger: { rate: number; firstTick: number }, lifeTicks: number): number[] {
  const out: number[] = [];
  const life = Math.min(lifeTicks, MAX_SIMULATED_TICKS);
  if (trigger.rate <= 0) {
    if (trigger.firstTick >= 1 && trigger.firstTick <= life) out.push(trigger.firstTick);
    return out;
  }
  const phase = ((trigger.firstTick % trigger.rate) + trigger.rate) % trigger.rate;
  for (let t = Math.max(1, trigger.firstTick); t <= life; t++) {
    if (t % trigger.rate === phase) out.push(t);
  }
  return out;
}

/** Where the enemy stands, in the caster-at-origin-facing-+Z frame. */
function targetPosition(placement: TargetPlacement): Point {
  const bearing = placement.bearing * DEG;
  return { x: -Math.sin(bearing) * placement.distance, z: Math.cos(bearing) * placement.distance };
}

function horizontalGap(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Whether a damage act resolved from `origin` reaches the target.
 *
 * The radius test is against the target's *hitbox*, not its centre: `EntityFinder` builds an
 * AABB and keeps anything intersecting it, so a mob whose edge is inside the radius is hit.
 * Line of sight (`AoeSelector.canHit`) is not modelled — it depends on terrain, and assuming
 * clear sight is the right default for a build planner.
 */
function reachesFrom(origin: Point, source: DamageSource, placement: TargetPlacement): boolean {
  return reaches(origin, source.target, placement);
}

/** The same test against a bare selector, for the gate a `PositionSource.TARGET` spawn carries. */
function reaches(origin: Point, selector: SourceTarget, placement: TargetPlacement): boolean {
  const target = targetPosition(placement);
  const gap = horizontalGap(origin, target);

  if (selector.kind === "aoe") {
    return gap <= selector.radius + placement.radius;
  }
  if (selector.kind === "in_front") {
    // A box `width` across and `distance` deep, centred on the caster's facing. The projectile
    // frame has the caster facing +Z, so depth is z and half-width is |x|.
    const dz = target.z - origin.z;
    const dx = Math.abs(target.x - origin.x);
    return dz >= -placement.radius && dz <= selector.distance + placement.radius
      && dx <= selector.width / 2 + placement.radius;
  }
  // `target` names the enemy outright; `self` and `none` never damage one.
  return selector.kind === "target";
}
