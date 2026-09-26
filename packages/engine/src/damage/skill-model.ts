/**
 * What one cast actually produces.
 *
 * The old model asked a spell for its *first* `damage` act and treated that as the whole skill.
 * That is right for the 132 damage sources that fire straight off `on_cast` and wrong for the
 * other 293: a spell's damage usually rides something — a projectile, a summoned block, a
 * block placed at where you were looking — and what it rides decides how many times it lands.
 *
 * `raging_dragon` is the case that makes it obvious. It declares two `damage` acts:
 *
 *   - `raging_dragon_slam`, on `on_cast`, an AoE of radius 2 around the caster — one hit;
 *   - `raging_dragon`, on the `default_entity_name` component group, gated on
 *     `x_ticks_condition { tick_rate: 4 }`, an AoE of radius 2 around *the projectile*.
 *
 * The second is carried by a projectile with `life_ticks: 60`, so it fires 15 times over that
 * projectile's life, and the spell throws one of those per projectile — nine, on a build with
 * eight bonus projectiles. Reading only the first act found in tree order picks the 0.2s tick
 * and throws the slam away; multiplying nothing by anything reports 1/136th of the cast.
 *
 * ## What this file decides, and what it refuses to
 *
 * It resolves, from the data alone:
 *
 *   - **carriers** — `projectile`, `summon_block`, `summon_at_sight`, or `direct` for an act on
 *     `on_cast` itself, each with the count one cast spawns and the ticks it lives for;
 *   - **triggers** — `on_cast`, `on_entity_expire`, `on_hit`, or `x_ticks_condition`, and for a
 *     tick, exactly which ticks of the carrier's life pass `tickCount % rate == firstTick % rate`
 *     (`OnTickCondition.canActivate`);
 *   - **targets** — the selector the act resolves against, with `AoeSelector`'s radius already
 *     multiplied by `AREA_MULTI`;
 *   - **requirements** — the `caster_has_mns_effect` gates, which is how the pack models combos:
 *     `raging_dragon` refuses to do anything at all without `combo_extender`.
 *
 * It refuses to decide how many of those instances reach a *given enemy*. A nova of nine
 * projectiles spiralling outward covers ground over time, and how much of it covers the enemy
 * you care about is geometry. `geometry.ts` answers that by integrating the flight the game
 * would have flown; this file hands it the numbers and never guesses.
 *
 * ## Component groups are reached, not just declared
 *
 * `entity_components` is a map from entity name to parts, and a group is only live if something
 * names it: `SummonProjectileAction`, `SummonBlockAction` and `SummonAtSightAction` all read
 * `MapField.ENTITY_NAME`, and `DoSpecificAction` activates a group inline, in the *caster's*
 * context rather than an entity's. Walking the map without resolving who spawns what counts
 * groups that never run, so the walk starts at `on_cast` and follows spawns outward.
 *
 * A fourth reach path is `ComponentPart.per_entity_hit`, a nested list of parts that
 * `tryActivate` runs **once for every entity the outer part's selector picked**, each in a
 * `SpellCtx.onEntityHit` context. 62 spells use it and it is where `frozen_orb`'s shards,
 * `rime_reaver`'s shards, `glacial_phoenix`'s ice and `chaos_totem`'s meteors come from — every
 * one of which looked like dead data until the field was read. Those sub-parts carry no selector
 * of their own: the acts run against `Arrays.asList(entity)`, the single entity that was hit.
 *
 * ## Where a carrier is — the origin
 *
 * The other half of "how many times does this land" is *where it resolves from*, and the game
 * answers it with one field: `SpellCtx.positionSource`, which `getPos()` and `getBlockPos()`
 * both go through and which `AoeSelector.get` receives as the centre of its search.
 *
 *   - `onCast` leaves it `SOURCE_ENTITY` with the caster as the source — the caster's feet;
 *   - `onTick` / `onExpire` set the source entity to the **carrier**, so a summoned block spawned
 *     inside a projectile's component group is placed at the projectile, not at the player;
 *   - `onHit` and `onEntityHit` set it to `TARGET` — an on-hit chain resolves at the enemy hit.
 *
 * So a damage act's position is a *chain*: an anchor, then every carrier between it and the act.
 * `Origin` records that chain and `geometry.ts` walks it. Before it existed every stationary
 * carrier was assumed to sit at the caster's feet, which is right for `on_cast` and wrong for the
 * 116 summoned blocks this pack spawns from something that had already moved.
 */

import type { ElementName } from "@cte2/schema";
import { ELEMENTS } from "@cte2/schema";

import { NO_EFFECTS, stacksHeldBy, type EffectHolder, type EffectState } from "./effect-state.js";
import type { SpellCalc, SpellConfig } from "./spell-calc.js";

/** Minecraft's tick rate, repeated here so this module stands alone. */
const TICKS_PER_SECOND = 20;

/** How deep a `projectile` → component → `projectile` chain is followed before giving up. */
const MAX_CARRIER_DEPTH = 4;

// ---------------------------------------------------------------------------
// The shape of a source
// ---------------------------------------------------------------------------

/** How a projectile moves, for `geometry.ts`. Every field is already stat-multiplied. */
export type ProjectileMotion = {
  /** `proj_speed` × `PROJECTILE_SPEED_MULTI`, in blocks per tick. */
  speed: number;
  /** `proj_accel`, in blocks per tick per tick. Applied before movement each tick. */
  acceleration: number;
  /** `yaw_velocity` × `PROJECTILE_YAW_SPEED_MULTI`, in degrees per tick. */
  yawVelocity: number;
  /** `yaw_acceleration`, in degrees per tick per tick. */
  yawAcceleration: number;
  /** True when the projectiles spread evenly around a full circle — `NOVA`. */
  nova: boolean;
  /** True when they line up abreast instead — `BARRAGE`. */
  barrage: boolean;
  /** `proj_apart`, the degrees a non-nova spread fans across. */
  apartDegrees: number;
  /** True when the projectile is deleted by the first enemy it touches. */
  expiresOnEntityHit: boolean;
  /** `orbits_caster`, which pins the projectile to a circle around the player instead. */
  orbitsCaster: boolean;
  orbitRadius: number;
  orbitSpeed: number;
  /** `tracks_enemies` — the projectile steers itself at whatever it finds. */
  tracksEnemies: boolean;
  /**
   * `shoot_way: FIND_ENEMY` — aimed once, at launch, at the closest enemy within this many
   * blocks of where it is fired from, and not fired at all when there is none. Undefined for
   * every other `shoot_way`, which fly on the caster's heading. Every totem that shoots is this.
   */
  enemySearchRadius?: number;
  /** True when the projectile is affected by gravity, which curves it down 0.05 blocks a tick. */
  gravity: boolean;
};

export type Carrier =
  /** The act sits on `on_cast`: it resolves against the caster, once, the moment you cast. */
  | { kind: "direct"; count: 1; lifeTicks: 0 }
  | {
      kind: "projectile";
      /** `proj_count` + `BONUS_PROJECTILES`, unless the act sets `ignore_bonus_proj`. */
      count: number;
      baseCount: number;
      bonusCount: number;
      /** `life_ticks`, with `DURATION_MULTI` applied only when `unaffect_by_duration` is false. */
      lifeTicks: number;
      motion: ProjectileMotion;
    }
  | {
      /** A block placed in the world — the pack's totems, ground fires and ice patches. */
      kind: "summon_block";
      count: number;
      /** `life_ticks` × `DURATION_MULTI`, which a block never opts out of. */
      lifeTicks: number;
      /** True when the block falls to the ground before it starts ticking. */
      falling: boolean;
      /**
       * `BlockSummonLimitGroup` — the named pool this block belongs to, when it is in one.
       *
       * 15 spells declare one: eleven totems and four banners. `enforceSummonLimit` culls the
       * oldest of the group on every cast, so `maxAlive` is a hard ceiling on how many of these
       * exist at once no matter how fast the button comes back. That is the difference between
       * a totem you can spam and one you place and leave, and it is the whole reason the field
       * is carried this far: nothing else in the model can express "the next cast destroys this".
       */
      limit?: { group: string; maxAlive: number };
    }
  | { kind: "summon_at_sight"; count: number; lifeTicks: number }
  /**
   * An `mmorpg_exile_effect` sitting on the caster, ticking its own component group.
   *
   * Eighteen of this pack's effects declare `damage` acts inside `ExileEffect.spell`, and for
   * four of them — Holy Fire, Sanguine Aura, Abyss Aura, Plague Aura — that is the *whole*
   * skill. The spell you press only toggles the effect on; what runs the damage is the effect's
   * own component group, every `tick_rate` ticks, for as long as the effect is up.
   *
   * It is not reached by walking `on_cast`, and never can be. The `exile_effect` act that grants
   * it sits behind a `caster_has_mns_effect … is_false` gate — press the button while the aura
   * is up and you turn it *off* — so on a build that runs the aura the granting branch is
   * correctly blocked and the removing one is live. `auras.ts` therefore enters from the other
   * end: from the effect the character is *holding*, which is a fact about the build rather than
   * about the button.
   *
   * `lifeTicks` is how long one cast's worth of it is counted for: the effect's own duration
   * when it has one, and the cast cycle when it is a permanent toggle — so that damage per cast
   * divided by the cycle comes out as the damage per second the aura really deals, whatever the
   * cycle happens to be.
   */
  | { kind: "effect"; effectId: string; count: 1; lifeTicks: number; permanent: boolean };

export type Trigger =
  | { kind: "on_cast" }
  | { kind: "expire" }
  | { kind: "on_hit" }
  | { kind: "tick"; rate: number; firstTick: number };

export type SourceTarget =
  | { kind: "aoe"; radius: number; selectionChance: number }
  | { kind: "in_front"; distance: number; width: number }
  | { kind: "target" }
  | { kind: "self" }
  /** No selector at all — the act needs none (a `projectile` act) or targets nothing. */
  | { kind: "none" };

// ---------------------------------------------------------------------------
// Where it resolves from
// ---------------------------------------------------------------------------

/**
 * Where one carrier was placed, relative to whatever spawned it.
 *
 * This is `SpellCtx.positionSource` at the moment the spawning act ran, and the game only has
 * three answers.
 */
export type SpawnFrom =
  /**
   * `PositionSource.SOURCE_ENTITY` — on the thing that spawned it: the parent carrier, or the
   * caster when the act sits on `on_cast`. The default, and what `onTick` and `onExpire` leave
   * in place.
   */
  | { kind: "parent" }
  /**
   * `SummonAtSightAction`'s ray-pick: `entity.pick(DISTANCE, 0, false)`, so the entity lands
   * where the crosshair lands, at most `distance` blocks out (`MapField.DISTANCE`, default 10).
   * Only happens when the position entity *is* the caster and the caster is a player.
   */
  | { kind: "sight"; maxDistance: number }
  /**
   * `PositionSource.TARGET` — at the enemy that was hit. `SpellCtx.onHit` and
   * `SpellCtx.onEntityHit` both set it.
   *
   * `gate` is the selector that had to find that enemy in the first place: the outer part's
   * own, for a `per_entity_hit` block. For an `on_hit` context the gate is the hit itself, and
   * `spawnedOn` already says so.
   */
  | { kind: "target"; gate: SourceTarget };

/**
 * One carrier between the caster and the act: what it is, when it was spawned, and where.
 *
 * `spawnedOn` is the trigger of the part that *spawned* it, which fires against the **parent's**
 * clock — so a `summon_block` under `x_ticks_condition { tick_rate: 5 }` inside a projectile's
 * group is dropped every fifth tick of that projectile's flight, at wherever it had got to.
 */
export type SpawnStep = {
  carrier: Carrier;
  spawnedOn: Trigger;
  from: SpawnFrom;
  /**
   * How many of this carrier one activation of the spawning part produces.
   *
   * `SummonBlockAction.getSummonCount` returns 1 unless the act names a `summon_limit_group`,
   * so this is `carrier.count` for a projectile and 1 for almost every block.
   */
  count: number;
  /**
   * `random_x_offset` / `random_z_offset`, in blocks.
   *
   * `SummonBlockAction.getRandomOffset` draws uniformly from `[0, offset]` in hundredths and
   * then flips the sign on a 50% roll, so the block lands uniformly on `[-offset, +offset]`.
   */
  scatter: { x: number; z: number };
  /**
   * `SummonBlockAction.ringPos`'s radius when one activation places more than one block:
   * `max(RING_SPACING, count × RING_SPACING / 2π)` with `RING_SPACING = 2`.
   */
  ringRadius: number;
};

/**
 * Where a damage act resolves, as a chain rather than a point.
 *
 * `chain` is every carrier from the caster out to this act's own carrier, outermost first, and
 * it is also the path that decides *whether* the act happens at all: each step's `spawnedOn`
 * fires against the previous step's life. An empty chain is an act on `on_cast` itself.
 */
export type Origin = {
  chain: SpawnStep[];
  /**
   * True when the act resolves at the enemy that was hit rather than at its carrier.
   *
   * `SpellCtx.onHit` and `SpellCtx.onEntityHit` both `setPositionSource(TARGET)`, so an on-hit
   * area is centred on the mob the projectile touched and a `per_entity_hit` act runs against
   * that mob alone. The chain still says whether the hit happened; this says where it landed.
   */
  atTarget: boolean;
};

/**
 * A gate on the part that carries a damage act — the two kinds the pack actually branches on.
 *
 * `exile_effect` is `caster_has_mns_effect` / `has_mns_effect`, which is how the pack builds
 * combo chains. `potion` is `caster_has_potion`, a plain vanilla `LivingEntity.hasEffect`:
 *
 *     MobEffect potion = BuiltInRegistries.MOB_EFFECT.get(new ResourceLocation(data.get(POTION_ID)));
 *     return ctx.caster.hasEffect(potion);
 *
 * — CasterHasEffectCondition.java:21-24, with `EffectCondition.can` applying `is_false` on top.
 *
 * The two kinds are separated because only one of them is answerable from a build. An exile
 * effect is something the build grants, so `EffectState` can say whether it is up; a vanilla
 * potion is world state that nothing in the document knows about, so it defaults to **absent**
 * and `config.conditions` is the only way to say otherwise.
 *
 * Reading the potion gate at all is what stops a mutually exclusive pair being counted twice.
 * `execute` is the pack's only user and declares its damage twice — `execute` when you are not
 * invisible, `execute_double` when you are — so with the gate unread both fired and one press
 * reported three times the hit the game deals.
 */
export type SourceRequirement = {
  /** Which gate this is, and therefore what `effectId` names. */
  kind: "exile_effect" | "potion";
  /** `mmorpg_exile_effect` id, or for a `potion` gate the `MobEffect` id. */
  effectId: string;
  /**
   * Which end of the hit has to be holding it.
   *
   * `caster_has_mns_effect` in `ifs` asks about you; `has_mns_effect` in `en_preds` asks about
   * whatever the part is aimed at, which for a damage part is the enemy. They are different
   * questions and `EffectState` already tracks the two sides separately — a stance sits on the
   * caster, a `shred` or a `soul_wound` stack sits on the target.
   */
  holder: EffectHolder;
  /** True when the gate is `is_false` — the effect must be *absent*. */
  negated: boolean;
  /**
   * `effect_stacks` — the gate passes at *at least* this many. 1 when the field is absent.
   *
   * This is what makes `armageddon`'s second meteor stream a four-stack question rather than a
   * yes/no one, and `soul_siphon`'s sacrifice branches three-stack ones.
   */
  minimumStacks: number;
};

/** One unsatisfied gate, and what it cost. */
export type BlockedGate = {
  requirement: SourceRequirement;
  /** How many `damage` acts sat behind it. */
  damageActs: number;
  /** Stacks currently assumed up, so a reader can see how far short it is. */
  activeStacks: number;
};

export type DamageSource = {
  /**
   * Stable across runs and readable in a breakdown: the carrier path, then the act index.
   * `on_cast#5` / `default_entity_name#7`.
   */
  id: string;
  /** How this source was reached, as names: `["on cast", "projectile default_entity_name"]`. */
  path: string[];
  valueCalcId: string;
  element: ElementName;
  carrier: Carrier;
  trigger: Trigger;
  target: SourceTarget;
  /** Where this act resolves from, and the spawn chain that put its carrier there. */
  origin: Origin;
  requires: SourceRequirement[];
  /**
   * How many times this act fires over **one carrier's** whole life.
   *
   * For a tick trigger this is the count of ticks in `1..lifeTicks` that satisfy
   * `t >= firstTick && t % rate == firstTick % rate` — `OnTickCondition.canActivate` against
   * `SimpleProjectileEntity.tick`, which runs `onTick` for `tickCount` 1 through `deathTime`
   * inclusive and removes the entity at the end of that last one.
   */
  firesPerCarrier: number;
  /**
   * How many of `carrier` one cast puts in the world, the whole spawn chain multiplied out.
   *
   * Not `carrier.count`: `fire_wall` throws five projectiles and each one lays a wall down when
   * it expires, so the wall's count per cast is five even though the `summon_block` act places
   * one. Every step contributes `count × (times the spawning part fires on its parent)`.
   */
  carriersPerCast: number;
  /** `carriersPerCast × firesPerCarrier` — every instance the cast produces, anywhere. */
  instancesPerCast: number;
  /**
   * The share of a *press* this source fires on, when `times_to_cast` makes one press several
   * casts.
   *
   * 1 for almost everything. `is_first_cast` and `is_last_cast` gate a part to one cast of the
   * run, so it is `1 / times_to_cast` for those — `storming_tiger` presses once, casts four
   * times, and throws its `is_last_cast` projectile on the fourth only.
   *
   * It is a share rather than a count because everything downstream multiplies a per-cast
   * figure by `rate.castsPerCycle`; folding it into `instancesPerCast` lets that multiplication
   * stay untouched and come out right.
   */
  castShare: number;
  /** `disable_knockback` on the act. Carried through so a breakdown can show it. */
  disableKnockback: boolean;
  /**
   * Ticks one enemy is immune to this source after it lands, when the part gates itself on a
   * cooldown it also sets: `is_not_on_cd` in `en_preds` and `set_on_cd` among the acts, same id.
   *
   * `SetOnCooldownAction` writes the cooldown onto each *target's* unit data and
   * `IsNotOnCooldownCondition` reads it off `ctx.target`, so the gate is per enemy and shared by
   * every carrier of the cast. `frost_orbs` throws three orbs that pulse every 5 ticks, and a mob
   * still takes one hit per 20 ticks however many orbs pass through it.
   */
  targetCooldownTicks?: number;
};

/**
 * One `exile_effect` act that puts stacks of something on the **enemy**.
 *
 * Counted with the same walk and the same firing arithmetic as a damage source, because the
 * question is the same one: how many times per cast does this act run where the target is.
 * `tailwind_sweep` applies one `snow_tracked` per press; `glacial_dash` applies three on every
 * tick its dash projectile lives; `banner_of_the_hunt` one every 30 ticks for the banner's life.
 *
 * What reads it is `effect-supply.ts`, for the procs that *spend* a debuff — Cryogenic Rupture
 * removes one `snow_tracked` every time it fires, so it can fire no faster than something puts
 * them back.
 */
export type EffectApplication = {
  effectId: string;
  /** `count` on the act: stacks one firing gives. */
  stacks: number;
  trigger: Trigger;
  carrier: Carrier;
  firesPerCarrier: number;
  carriersPerCast: number;
  /** The same share of a `times_to_cast` press {@link DamageSource.castShare} is. */
  castShare: number;
};

export type SkillModel = {
  spellId: string;
  sources: DamageSource[];
  /**
   * Every carrier one cast spawns, whether or not it carries damage.
   *
   * Kept separately because the two questions are different: `raging_dragon`'s combo_remover
   * projectile deals nothing and is still a projectile the spell threw, and a spell whose
   * projectile's component group is missing entirely should still report its projectile count
   * rather than claim it has none.
   */
  carriers: Carrier[];
  /**
   * Gates that switched a branch off, and how many damage acts went with it.
   *
   * The pack writes a third of its skills as branch tables: `soul_siphon` has eight mutually
   * exclusive `on_cast` parts keyed on which aura you run, `armageddon` declares its meteors
   * twice with the second copy gated on four `overheat` stacks. Counting all of them at once —
   * which is what assuming every gate satisfied does — reports a spell firing four different
   * projectiles simultaneously.
   *
   * So a part whose gates fail produces no sources, and what it would have produced is recorded
   * here instead: the answer to "why is this skill reporting less than its tooltip".
   */
  blockedBy: BlockedGate[];
  /** Component groups that no act reaches. Dead data, or a spawn form not modelled yet. */
  unreachableGroups: string[];
  /** Act types seen inside reached groups that this model does not interpret. */
  unmodelledActs: string[];
  /**
   * Summoning acts this cast reaches, whose output is not counted.
   *
   * Separate from {@link unmodelledActs} because the shape of the gap is different: the act is
   * understood, and what it spawns has a stat sheet and a basic attack that nothing here flies.
   * A spell whose whole output is its summons therefore reports zero, and this is what lets it
   * say so rather than look like a modelling failure.
   */
  unmodelledSummons: string[];
  /** Stacks this cast puts on enemies, act by act. See {@link EffectApplication}. */
  applications: EffectApplication[];
};

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

type Part = {
  acts: RawAct[];
  ifs: RawAct[];
  /**
   * `ComponentPart.en_preds` — the same gate machinery aimed at the **entity the part targets**
   * rather than at the caster.
   *
   * Fourteen spells in this pack write a branch table with these, and they are the only place a
   * "how debuffed is the enemy" question can be asked. Reading only `ifs` left both halves of
   * every such table switched on at once: `soul_wound` declares a big hit gated on the target
   * holding three stacks and a small one gated on it *not* holding three, and a cast was being
   * billed for both.
   */
  enPreds: RawAct[];
  targets: RawAct[];
  /** `ComponentPart.per_entity_hit` — parts re-run once per entity this part's selector picked. */
  perEntityHit: Part[];
};

type RawAct = { type: string; map: Record<string, unknown> };

/**
 * Enumerates every damage source one cast of this spell produces.
 *
 * `entryGroup` is the component group the walk starts from, and is `on_cast` for everything you
 * press. A summon's basic attack is the exception: `PetAttackUTIL.tryAttack` runs
 *
 *     basic.attached.onCast(SpellCtx.onCast(caster, ctx.calcData));
 *     basic.attached.tryActivate(Spell.DEFAULT_EN_NAME, SpellCtx.onHit(caster, summon, target, ...));
 *
 * — so the pet's swing enters `default_entity_name` *directly*, at an `on_hit` context, with no
 * cast and nothing spawning it. Walking those spells from `on_cast` is why all seventeen of them
 * report zero sources and their one real group reports as unreachable: it is not unreachable, it
 * has a different driver.
 *
 * `calc` is the output of `on_spell_stat_calc`, so bonus projectiles, `AREA_MULTI`,
 * `DURATION_MULTI`, `NOVA` and the projectile speed multipliers are all already the values the
 * character's stats produced. Passing a fresh `calc` is what makes `plus_aoe` widen every AoE
 * radius here and `reduced_proj_speed` slow every flight.
 */
export function skillModel(
  spell: Record<string, unknown>,
  declared: SpellConfig,
  calc: SpellCalc,
  effects: EffectState = NO_EFFECTS,
  entryGroup = "on_cast",
  /** `build.config.conditions` — the only thing that can answer a `caster_has_potion` gate. */
  conditions: Record<string, boolean> | undefined = undefined,
  /**
   * The carrier the entry group is already riding, when it is not the cast itself.
   *
   * `DIRECT` is right for a button: the parts on `on_cast` run once, at the caster, with no
   * entity behind them. An exile effect's group is the opposite — it is driven by something
   * that persists, and its `x_ticks_condition` gates count against *that* thing's life rather
   * than falling back to the caster's unsynchronised `tickCount`. Handing the carrier in is what
   * lets `firesFor` answer "sixteen pulses over eight seconds" instead of "one tick in ten".
   */
  entryCarrier: Carrier = DIRECT,
): SkillModel {
  const attached = asObject(spell["attached"]) ?? {};
  const groups = readGroups(attached);
  const sources: DamageSource[] = [];
  const carriers: Carrier[] = [];
  const reached = new Set<string>([entryGroup]);
  const unmodelled = new Set<string>();
  const summons = new Set<string>();
  const blocked = new Map<string, BlockedGate>();
  const applications: EffectApplication[] = [];

  /**
   * One frame of the walk: the carrier whose component group is being read, the spawn chain
   * that placed it, and how many of it a cast produces once that chain is multiplied out.
   */
  type Frame = {
    carrier: Carrier;
    chain: SpawnStep[];
    carriersPerCast: number;
    path: string[];
  };

  const walk = (parts: Part[], groupName: string, frame: Frame, depth: number): void => {
    parts.forEach((part, index) => {
      const trigger = triggerOf(part, frame.carrier);
      const target = targetOf(part, calc);
      const requires = requirementsOf(part);

      // All of a part's `ifs` are ANDed, so one failed gate switches off its acts, its
      // `per_entity_hit` block and everything they would have spawned. Recorded rather than
      // dropped: "this branch is waiting on four `overheat` stacks" is the useful answer.
      const failed = requires.filter((requirement) => !gateHolds(requirement, effects, conditions));
      if (failed.length > 0) {
        const acts = countDamageActs(part, groups);
        for (const requirement of failed) {
          const key = `${requirement.kind}:${requirement.effectId}:${requirement.negated}:${requirement.minimumStacks}`;
          const existing = blocked.get(key);
          if (existing) existing.damageActs += acts;
          else {
            blocked.set(key, {
              requirement,
              damageActs: acts,
              activeStacks:
                requirement.kind === "potion" ? 0 : (effects.active.get(requirement.effectId) ?? 0),
            });
          }
        }
        return;
      }

      const firesPerCarrier = firesFor(trigger, frame.carrier);
      // `SpellCastingData` runs a `times_to_cast` spell as that many casts off one press, and
      // `is_first_cast` / `is_last_cast` pick one of them. Unread, the part ran on every cast:
      // `storming_tiger` threw its last-cast projectile four times instead of once.
      const castShare = onceForTheRun(part) ? 1 / Math.max(1, declared.timesToCast) : 1;
      // `SpellCtx.onHit` sets `PositionSource.TARGET`, so everything an on-hit part does — its
      // own selector, and anything it spawns — resolves at the mob that was touched rather than
      // at the projectile that touched it.
      const atTarget = trigger.kind === "on_hit";
      const onEnemy = selectsEnemies(part);

      /** Follows one act: a `damage` to a source, a spawn to another frame, a jump to a group. */
      const run = (
        act: RawAct,
        from: SpawnFrom,
        resolvesAtTarget: boolean,
        hits: SourceTarget,
        enemy: boolean,
      ): void => {
        if (act.type === "exile_effect") {
          const effectId = str(act.map["exile_potion_id"]);
          const action = str(act.map["potion_action"]) ?? "GIVE_STACKS";
          if (enemy && effectId !== undefined && action === "GIVE_STACKS") {
            applications.push({
              effectId,
              stacks: Math.max(1, Math.trunc(num(act.map["count"]) ?? 1)),
              trigger,
              carrier: frame.carrier,
              firesPerCarrier,
              carriersPerCast: frame.carriersPerCast,
              castShare,
            });
          }
          return;
        }
        if (act.type === "damage") {
          const targetCooldownTicks = targetCooldownOf(part);
          sources.push({
            id: `${groupName}#${index}`,
            path: frame.path,
            valueCalcId: str(act.map["value_calculation"]) ?? "",
            element: elementOf(act.map["element"]),
            carrier: frame.carrier,
            trigger,
            target: hits,
            origin: { chain: frame.chain, atTarget: resolvesAtTarget },
            requires,
            firesPerCarrier,
            carriersPerCast: frame.carriersPerCast,
            instancesPerCast: frame.carriersPerCast * firesPerCarrier * castShare,
            castShare,
            disableKnockback: act.map["disable_knockback"] === true,
            ...(targetCooldownTicks === undefined ? {} : { targetCooldownTicks }),
          });
          return;
        }

        if (depth >= MAX_CARRIER_DEPTH) return;

        const spawned = carrierFor(act, calc);
        if (spawned) {
          const name = str(act.map["entity_name"]) ?? "default_entity_name";
          const next = groups.get(name);
          reached.add(name);
          carriers.push(spawned.carrier);
          // `SummonAtSightAction` ray-picks only when the position entity is the caster, which
          // is true exactly when nothing else has moved the context: a summon at sight straight
          // off `on_cast` lands at the crosshair, one nested inside a projectile's group lands
          // at the projectile, and one in a `TARGET` context lands on the mob.
          const placedAt: SpawnFrom =
            spawned.atSight && from.kind === "parent" && frame.chain.length === 0
              ? { kind: "sight", maxDistance: spawned.sightDistance }
              : from;
          const step: SpawnStep = {
            carrier: spawned.carrier,
            spawnedOn: trigger,
            from: placedAt,
            count: spawned.count,
            scatter: spawned.scatter,
            ringRadius: spawned.ringRadius,
          };
          if (next) {
            walk(next, name, {
              carrier: spawned.carrier,
              chain: [...frame.chain, step],
              carriersPerCast: frame.carriersPerCast * step.count * firesPerCarrier,
              path: [...frame.path, `${act.type} ${name}`],
            }, depth + 1);
          }
          return;
        }

        if (act.type === "specific_action") {
          // `DoSpecificAction` runs another group's parts **in the current context**, so the
          // carrier does not change — it is a jump, not a spawn.
          const name = str(act.map["specific_action"]);
          const next = name === undefined ? undefined : groups.get(name);
          if (name !== undefined) reached.add(name);
          if (next && name !== undefined) {
            walk(next, name, { ...frame, path: [...frame.path, `do ${name}`] }, depth + 1);
          }
          return;
        }

        if (UNMODELLED_SPAWNS.has(act.type)) summons.add(act.type);
        else if (!IGNORED_ACTS.has(act.type)) unmodelled.add(act.type);
      };

      const ownFrom: SpawnFrom = atTarget ? { kind: "target", gate: target } : { kind: "parent" };
      for (const act of part.acts) run(act, ownFrom, atTarget, target, onEnemy);

      // `ComponentPart.tryActivate` finishes by re-running every `per_entity_hit` part once per
      // entity the selector above picked, through `SpellCtx.onEntityHit` — a `TARGET` context
      // holding that one entity. The sub-parts declare no selector of their own: the acts run
      // against `Arrays.asList(entity)`, so whether the target is reached is the outer
      // selector's question and the outer position's, which is why both are passed down.
      if (part.perEntityHit.length > 0 && target.kind !== "none" && target.kind !== "self") {
        const hitFrom: SpawnFrom = { kind: "target", gate: target };
        for (const inner of part.perEntityHit) {
          for (const act of inner.acts) run(act, hitFrom, true, target, onEnemy);
        }
      }
    });
  };

  walk(groups.get(entryGroup) ?? [], entryGroup, {
    carrier: entryCarrier,
    chain: [],
    carriersPerCast: 1,
    path: [entryGroup === "on_cast" ? "on cast" : entryGroup],
  }, 0);

  return {
    spellId: str(spell["identifier"]) ?? "",
    sources,
    carriers,
    blockedBy: [...blocked.values()].sort((a, b) => b.damageActs - a.damageActs),
    unreachableGroups: [...groups.keys()].filter((g) => g !== "on_cast" && !reached.has(g)),
    unmodelledActs: [...unmodelled].sort(),
    unmodelledSummons: [...summons].sort(),
    applications,
  };
}

/**
 * Whether a part's selector lands on enemies — the same rule `effect-state.ts` uses to decide who
 * holds a granted effect: `self` is the caster, and so is an area searching allies, summons or
 * pets. A part with no selector reaches nobody.
 */
function selectsEnemies(part: Part): boolean {
  if (part.targets.length === 0) return false;
  return part.targets.every((target) => {
    if (target.type === "self") return false;
    const predicate = str(target.map["en_predicate"]);
    return !(
      predicate === "allies" ||
      predicate === "casters_summons" ||
      predicate === "pets"
    );
  });
}

/**
 * How many `damage` acts a part would have produced, everything it spawns included.
 *
 * Counting only the acts written in the part reports zero for most blocked branches, because
 * the pack's usual shape is a gated `on_cast` part that throws a projectile and a component
 * group that does the damage. Following the spawn is what makes "this branch is waiting on
 * `plague_aura`" a statement about damage rather than about a projectile.
 */
function countDamageActs(
  part: Part,
  groups: Map<string, Part[]>,
  seen: Set<string> = new Set(),
): number {
  let n = 0;
  const follow = (name: string | undefined): void => {
    if (name === undefined || seen.has(name)) return;
    seen.add(name);
    for (const next of groups.get(name) ?? []) n += countDamageActs(next, groups, seen);
  };

  for (const act of part.acts) {
    if (act.type === "damage") n++;
    else if (act.type === "projectile" || act.type === "summon_block" || act.type === "summon_at_sight") {
      follow(str(act.map["entity_name"]) ?? "default_entity_name");
    } else if (act.type === "specific_action") {
      follow(str(act.map["specific_action"]));
    }
  }
  for (const inner of part.perEntityHit) n += countDamageActs(inner, groups, seen);
  return n;
}

const DIRECT: Carrier = { kind: "direct", count: 1, lifeTicks: 0 };

/**
 * Acts that carry no damage and spawn nothing, so their absence from the model is not a gap.
 * Anything outside this list and outside the carriers is reported by `unmodelledActs`, which
 * is how a spell form this file does not yet understand becomes visible instead of silent.
 */
const IGNORED_ACTS = new Set([
  "particles_in_radius",
  "sound",
  "sound_per_target",
  "sword_sweep_particles",
  "caster_command",
  "aggro",
  "expire",
  "cancel_cast",
  "set_on_cd",
  "refresh_cds",
  "motion",
  "push",
  "knockback",
  "tp_to_caster",
  "tp_target_to_self",
  "teleport_caster_to_sight",
  "open_ender_chest",
  "give_arrows_if_no_infi",
  "ride",
  "add_charge",
  "block_summon_limit_group",
  "command_summons",
  "restore_health",
  "restore_mana",
  "restore_energy",
  "restore_blood",
  "restore_magic_shield",
  "potion",
  "exile_effect",
  "do_action_for_each_effect_on_target",
]);

/**
 * Acts that put something in the world which fights for you, and which this model cannot follow.
 *
 * Deliberately *not* in {@link IGNORED_ACTS}: something that fights for you and is not counted is
 * a hole, and a hole should say so rather than reading as "carries no damage".
 *
 * `summon_pet` **used to be here** and is not any more. A pet is not a second character with its
 * own stat sheet, which is what kept it out: `PetAttackUTIL.tryAttack` casts the pet's basic
 * attack as *you*, against your sheet, so it is an ordinary spell of yours on vanilla's AI clock.
 * `summons.ts` follows it, and `DpsResult.summons` is the answer.
 *
 * The two that remain are vanilla entities rather than Mine and Slash summons —
 * `EvokerFangs` and a lightning bolt — whose damage is vanilla's and is not on any sheet at all.
 */
const UNMODELLED_SPAWNS = new Set([
  "summon_evoker_fangs",
  "summon_lightning_strike",
]);

// ---------------------------------------------------------------------------
// Carriers
// ---------------------------------------------------------------------------

/** `SummonBlockAction.RING_SPACING` — blocks between two of a multi-block summon. */
const RING_SPACING = 2;

/** `SummonAtSightAction`'s `MapField.DISTANCE` default: how far the ray-pick reaches. */
const DEFAULT_SIGHT_DISTANCE = 10;

/** What a spawning act produces: the carrier, and how the act placed it. */
type Spawn = Omit<SpawnStep, "carrier" | "spawnedOn" | "from"> & {
  carrier: Carrier;
  /** True for `summon_at_sight`, which ray-picks *if* the position entity is the caster. */
  atSight: boolean;
  sightDistance: number;
};

/**
 * The carrier an act spawns, or undefined when it spawns nothing.
 *
 * `SummonProjectileAction` reads `BONUS_PROJECTILES` off the calculated spell data unless the
 * act sets `ignore_bonus_proj`, and `SimpleProjectileEntity.init` applies `DURATION_MULTI` to
 * the lifespan only when `unaffect_by_duration` is explicitly **false** — the field defaults to
 * true, so a projectile normally ignores duration entirely. A summoned block is the other way
 * round: `StationaryFallingBlockEntity` multiplies its lifespan by `DURATION_MULTI` with no
 * opt-out at all.
 *
 * `SummonBlockAction.getSummonCount` returns 1 outright unless the act names a
 * `summon_limit_group`, in which case it is `max(1, min(1 + extra_<group>, max_<group>))` off the
 * event data. Both halves come off the `on_spell_stat_calc` sweep: `max_totems` and `max_banners`
 * raise the ceiling, and nothing in this pack writes `extra_totems` or `extra_banners`, so a cast
 * places one block and the ceiling decides how many of them survive the *next* cast.
 */
function carrierFor(act: RawAct, calc: SpellCalc): Spawn | undefined {
  const map = act.map;
  const noScatter = { x: 0, z: 0 };

  if (act.type === "projectile") {
    const base = num(map["proj_count"]) ?? 1;
    const bonus = map["ignore_bonus_proj"] === true ? 0 : calc.bonusProjectiles;
    const life = num(map["life_ticks"]) ?? 0;
    // `getOrDefault(UNAFFECTED_BY_DURATION, true)`: the default is to ignore duration.
    const unaffected = map["unaffect_by_duration"] !== false;
    const count = Math.max(0, base + bonus);
    return {
      carrier: {
        kind: "projectile",
        baseCount: base,
        bonusCount: bonus,
        count,
        lifeTicks: Math.trunc(unaffected ? life : life * calc.durationMulti),
        motion: {
          speed: (num(map["proj_speed"]) ?? 0) * calc.projectileSpeedMulti,
          acceleration: num(map["proj_accel"]) ?? 0,
          yawVelocity: (num(map["yaw_velocity"]) ?? 0) * calc.projectileYawSpeedMulti,
          yawAcceleration: num(map["yaw_acceleration"]) ?? 0,
          // Either the stat sweep set it or the act declares it — `ProjectileCastHelper.cast`
          // checks both: `data.getBoolean(NOVA) || holder.getOrDefault(MapField.NOVA, false)`.
          nova: calc.nova || map["nova"] === true,
          barrage: calc.barrage,
          apartDegrees: num(map["proj_apart"]) ?? 75,
          // `getOrDefault(EXPIRE_ON_ENTITY_HIT, true)`.
          expiresOnEntityHit: map["expire_on_en_hit"] !== false,
          orbitsCaster: map["orbits_caster"] === true,
          orbitRadius: num(map["orbit_radius"]) ?? 0,
          orbitSpeed: num(map["orbit_speed"]) ?? 0,
          tracksEnemies: map["tracks_enemies"] === true,
          // `getOrDefault(GRAVITY, true)`, then `setNoGravity(!gravity)`.
          gravity: map["gravity"] !== false,
          ...(map["shoot_way"] === "FIND_ENEMY"
            ? {
                enemySearchRadius: enemySearchRadius(
                  (num(map["proj_speed"]) ?? 0) * calc.projectileSpeedMulti,
                  life,
                ),
              }
            : {}),
        },
      },
      count,
      scatter: noScatter,
      ringRadius: 0,
      atSight: false,
      sightDistance: 0,
    };
  }

  if (act.type === "summon_block") {
    // `getSummonCount`: 1 outright with no group, otherwise `max(1, min(1 + extra, max))`.
    const limit = summonLimit(str(map["summon_limit_group"]), calc);
    const count = limit === undefined ? 1 : Math.max(1, Math.min(1 + limit.extra, limit.maxAlive));
    return {
      carrier: {
        kind: "summon_block",
        count,
        lifeTicks: Math.trunc((num(map["life_ticks"]) ?? 0) * calc.durationMulti),
        falling: map["is_falling_block"] === true,
        ...(limit === undefined ? {} : { limit: { group: limit.group, maxAlive: limit.maxAlive } }),
      },
      count,
      scatter: { x: num(map["random_x_offset"]) ?? 0, z: num(map["random_z_offset"]) ?? 0 },
      ringRadius: count > 1 ? Math.max(RING_SPACING, (count * RING_SPACING) / (2 * Math.PI)) : 0,
      atSight: false,
      sightDistance: 0,
    };
  }

  if (act.type === "summon_at_sight") {
    const count = 1;
    return {
      carrier: {
        kind: "summon_at_sight",
        count,
        lifeTicks: Math.trunc((num(map["life_ticks"]) ?? 0) * calc.durationMulti),
      },
      count,
      scatter: noScatter,
      ringRadius: 0,
      // `pos_source` on the act overrides the context's own: `getOrDefault(ctx.getPositionSource())`.
      // Only a source that still resolves to the caster ray-picks, so an explicit `SOURCE_ENTITY`
      // inside a carrier's group — `meteor_arrow`'s `height_en` — stays on the carrier.
      atSight: str(map["pos_source"]) !== "SOURCE_ENTITY",
      sightDistance: num(map["distance"]) ?? DEFAULT_SIGHT_DISTANCE,
    };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

function triggerOf(part: Part, carrier: Carrier): Trigger {
  for (const gate of part.ifs) {
    if (gate.type === "x_ticks_condition") {
      return {
        kind: "tick",
        rate: Math.trunc(num(gate.map["tick_rate"]) ?? 0),
        firstTick: Math.trunc(num(gate.map["first_tick"]) ?? 0),
      };
    }
  }
  for (const gate of part.ifs) {
    if (gate.type === "on_entity_expire") return { kind: "expire" };
    if (gate.type === "on_hit") return { kind: "on_hit" };
  }
  // No gate at all behaves like `on_cast` for a direct part and like an expire for a carried
  // one, because a carried part with no activation only ever runs when something drives it.
  return carrier.kind === "direct" ? { kind: "on_cast" } : { kind: "expire" };
}

/**
 * How many times a trigger fires over one carrier's whole life.
 *
 * The tick arithmetic is `OnTickCondition.canActivate` read against the entity loop:
 *
 *     return tickCount >= firstTick && tickCount % ticks == firstTick % ticks;   // ticks > 0
 *     return tickCount == firstTick;                                            // ticks <= 0
 *
 * and `SimpleProjectileEntity.tick` calls `onTick()` *before* it checks
 * `tickCount >= getDeathTime()`, so the last live tick is `lifeTicks` itself and the range is
 * `1..lifeTicks` inclusive. Vanilla increments `tickCount` in `super.tick()` first, so tick 0
 * is never seen by a component.
 */
/**
 * `BlockSummonLimitGroup.fromId` — the two named pools, with the numbers the sweep produced.
 *
 * An unknown id is not a group: `fromId` returns null for anything but `totem` and `banner`, and
 * a null group makes `getSummonCount` return 1 without reading either number.
 */
function summonLimit(
  group: string | undefined,
  calc: SpellCalc,
): { group: string; maxAlive: number; extra: number } | undefined {
  if (group === "totem") return { group, maxAlive: calc.maxTotems, extra: calc.extraTotems };
  if (group === "banner") return { group, maxAlive: calc.maxBanners, extra: calc.extraBanners };
  return undefined;
}

/**
 * How many times a trigger fires over a carrier that lives `lifeTicks`.
 *
 * Split out of {@link firesFor} so a caller that has to shorten a carrier's life — a totem the
 * next cast destroys — can ask the same question of the shorter one rather than scaling the
 * answer, which would be wrong whenever the pulses are not evenly spread over the life.
 */
export function firesWithin(trigger: Trigger, carrier: Carrier, lifeTicks: number): number {
  return firesFor(trigger, { ...carrier, lifeTicks } as Carrier);
}

function firesFor(trigger: Trigger, carrier: Carrier): number {
  switch (trigger.kind) {
    case "on_cast":
      return 1;
    case "expire":
      return 1;
    case "on_hit":
      // One hit. A piercing or chaining projectile hits more, but how many more is the same
      // geometry question the projectile count is, so it is left to the caller rather than
      // multiplied in here.
      return 1;
    case "tick": {
      if (carrier.kind === "direct") {
        // No carrier entity, so `OnTickCondition` falls back to the caster's own `tickCount`,
        // which is unsynchronised with the cast. Over many casts the gate opens on one tick in
        // `rate`, and that expectation is the only honest number a static document can give.
        return trigger.rate > 0 ? 1 / trigger.rate : 1;
      }
      const life = carrier.lifeTicks;
      if (life <= 0) return 0;
      if (trigger.rate <= 0) {
        // `tickCount == firstTick` — fires exactly once, and only if it lives that long.
        return trigger.firstTick >= 1 && trigger.firstTick <= life ? 1 : 0;
      }
      const phase = ((trigger.firstTick % trigger.rate) + trigger.rate) % trigger.rate;
      let count = 0;
      for (let t = Math.max(1, trigger.firstTick); t <= life; t++) {
        if (t % trigger.rate === phase) count++;
      }
      return count;
    }
  }
}

// ---------------------------------------------------------------------------
// Targets and gates
// ---------------------------------------------------------------------------

/** `AoeSelector.get` multiplies its declared radius by `AREA_MULTI` before it searches. */
function targetOf(part: Part, calc: SpellCalc): SourceTarget {
  for (const target of part.targets) {
    switch (target.type) {
      case "aoe":
        return {
          kind: "aoe",
          radius: (num(target.map["radius"]) ?? 0) * calc.areaMulti,
          selectionChance: clamp01((num(target.map["selection_chance"]) ?? 100) / 100),
        };
      case "in_front":
        return {
          kind: "in_front",
          distance: (num(target.map["distance"]) ?? 0) * calc.areaMulti,
          width: (num(target.map["width"]) ?? 0) * calc.areaMulti,
        };
      case "target":
        return { kind: "target" };
      case "self":
        return { kind: "self" };
    }
  }
  return { kind: "none" };
}

/**
 * Whether this part runs on one cast of a multi-cast press rather than on all of them.
 *
 * `is_first_cast` and `is_last_cast` are the only two gates that do this, and they are read
 * nowhere else — which is why an unread gate is worth an audit check of its own: it does not
 * fail, it reads as true, and the part simply happens more often than it should.
 *
 * Five parts in the pack use them, across `omnislash`, `storming_tiger` and `triple_blitz`.
 * Four grant an exile effect and cost nothing; `storming_tiger`'s `on_cast[5]` throws a
 * projectile, and that one was worth four times what it should have been.
 */
function onceForTheRun(part: Part): boolean {
  return part.ifs.some((gate) => gate.type === "is_first_cast" || gate.type === "is_last_cast");
}

/**
 * The per-enemy cooldown a part both checks and sets — see `DamageSource.targetCooldownTicks`.
 *
 * Only when both halves sit on the same part. `soul_wound` sets its cooldown on one branch and
 * checks it on the other, which is a branch table rather than a rate limit.
 */
function targetCooldownOf(part: Part): number | undefined {
  for (const gate of part.enPreds) {
    if (gate.type !== "is_not_on_cd") continue;
    const id = str(gate.map["cooldown_id"]);
    const set = part.acts.find((act) => act.type === "set_on_cd" && str(act.map["cooldown_id"]) === id);
    const ticks = set === undefined ? undefined : num(set.map["cooldown_ticks"]);
    if (ticks !== undefined && ticks > 0) return ticks;
  }
  return undefined;
}

function requirementsOf(part: Part): SourceRequirement[] {
  const out: SourceRequirement[] = [];
  const read = (gates: RawAct[], holder: EffectHolder): void => {
    for (const gate of gates) {
      // `caster_has_potion` reads `ctx.caster` whichever list it sits in, so it is the caster's
      // either way — all three of this pack's uses are in `en_preds`, where an exile-effect gate
      // would have been the target's.
      if (gate.type === "caster_has_potion") {
        const potionId = str(gate.map["potion_id"]);
        if (potionId === undefined) continue;
        out.push({
          kind: "potion",
          effectId: potionId,
          holder: "caster",
          negated: gate.map["is_false"] === true,
          minimumStacks: 1,
        });
        continue;
      }
      if (gate.type !== "caster_has_mns_effect" && gate.type !== "has_mns_effect") continue;
      const effectId = str(gate.map["exile_potion_id"]);
      if (effectId === undefined) continue;
      out.push({
        kind: "exile_effect",
        effectId,
        holder,
        negated: gate.map["is_false"] === true,
        minimumStacks: Math.max(1, Math.trunc(num(gate.map["effect_stacks"]) ?? 1)),
      });
    }
  };
  read(part.ifs, "caster");
  read(part.enPreds, "target");
  return out;
}

/** The `config.conditions` key that answers a potion gate. */
export function potionConditionKey(potionId: string): string {
  return `caster_has_potion:${potionId}`;
}

/**
 * `CasterHasExileEffectCondition`: the caster must hold at least `effect_stacks` of the effect,
 * and `is_false` flips the answer.
 *
 * Every gate on a part is ANDed — `ComponentPart.tryActivate` returns early unless
 * `EffectCondition.conditionsPass` is true for all of them — so one failure switches the whole
 * part off, acts, targets and `per_entity_hit` block together.
 */
function gateHolds(
  requirement: SourceRequirement,
  effects: EffectState,
  conditions: Record<string, boolean> | undefined,
): boolean {
  // A vanilla potion is world state, not a property of the build — the same family as
  // `is_in_combat` and `is_day`, which `conditions.ts` treats as inactive and reports rather
  // than guessing at. Absent unless the document says otherwise, and `is_false` then flips it,
  // which is what makes the un-invisible branch of `execute` the one that fires.
  if (requirement.kind === "potion") {
    const held = conditions?.[potionConditionKey(requirement.effectId)] === true;
    return requirement.negated ? !held : held;
  }

  // A caster gate reads the side-blind list and a target gate does not, which is deliberate
  // rather than an oversight. Which side an effect is filed under is *derived* — from the
  // target selector of whatever part grants it — and a combo link handed to you by your own
  // previous skill can land on either side of that guess. Holding a caster gate to it would
  // switch off chains that work today for a reason that has nothing to do with the gate.
  //
  // A target gate has no such fallback available: "the enemy is holding three stacks" is
  // exactly the question, and answering it off a list that includes your own buffs would pass
  // every debuff gate for free, because you are the one who applied the debuff.
  const active =
    requirement.holder === "caster"
      ? (effects.active.get(requirement.effectId) ?? 0)
      : stacksHeldBy(effects, requirement.effectId, "target");
  const held = active >= requirement.minimumStacks;
  return requirement.negated ? !held : held;
}

/**
 * Whether a spell declares any `damage` act at all, without building its whole model.
 *
 * A one-pass walk of the act tree, used to pick a sensible main skill when a document names
 * none. It answers a weaker question than {@link skillModel}: "could this ever hit something",
 * not "what does it hit for" — so it costs a tree walk rather than two stat sheets, which is
 * what makes it affordable over a whole skill bar.
 */
export function declaresDamage(spell: Record<string, unknown>): boolean {
  const attached = asObject(spell["attached"]) ?? {};
  const groups = readGroups(attached);
  for (const parts of groups.values()) {
    for (const part of parts) {
      if (countDamageActs(part, groups, new Set()) > 0) return true;
    }
  }
  return false;
}

/** Every effect a spell's gates ask for positively, for the exclusivity tiebreak. */
export function gatedEffectIds(spell: Record<string, unknown>): string[] {
  const attached = asObject(spell["attached"]) ?? {};
  const out: string[] = [];
  const seen = new Set<string>();
  for (const parts of readGroups(attached).values()) {
    for (const part of parts) {
      for (const requirement of requirementsOf(part)) {
        // Exile effects only: this feeds the `one_of_a_kind_id` tiebreak, and a vanilla potion
        // id is not something `resolveEffectState` could ever find.
        if (requirement.kind !== "exile_effect") continue;
        if (requirement.negated || seen.has(requirement.effectId)) continue;
        seen.add(requirement.effectId);
        out.push(requirement.effectId);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading the tree
// ---------------------------------------------------------------------------

function readGroups(attached: Record<string, unknown>): Map<string, Part[]> {
  const groups = new Map<string, Part[]>();
  groups.set("on_cast", readParts(attached["on_cast"]));
  for (const [name, parts] of Object.entries(asObject(attached["entity_components"]) ?? {})) {
    groups.set(name, readParts(parts));
  }
  return groups;
}

function readParts(node: unknown): Part[] {
  if (!Array.isArray(node)) return [];
  return node.map((raw) => {
    const obj = asObject(raw) ?? {};
    return {
      acts: readActs(obj["acts"]),
      ifs: readActs(obj["ifs"]),
      enPreds: readActs(obj["en_preds"]),
      targets: readActs(obj["targets"]),
      perEntityHit: readParts(obj["per_entity_hit"]),
    };
  });
}

function readActs(node: unknown): RawAct[] {
  if (!Array.isArray(node)) return [];
  const out: RawAct[] = [];
  for (const raw of node) {
    const obj = asObject(raw);
    const type = obj === undefined ? undefined : str(obj["type"]);
    if (obj === undefined || type === undefined) continue;
    out.push({ type, map: asObject(obj["map"]) ?? {} });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

/** Seconds a carrier persists, for a panel that wants to say "over 3.0s". */
export function carrierSeconds(carrier: Carrier): number {
  return carrier.lifeTicks / TICKS_PER_SECOND;
}

/** A short human label for a source, for a breakdown row. */
export function sourceLabel(source: DamageSource): string {
  const where =
    source.carrier.kind === "direct"
      ? "on cast"
      : source.carrier.kind === "projectile"
        ? `${source.carriersPerCast}× projectile`
        : source.carrier.kind === "summon_block"
          ? `${source.carriersPerCast}× summoned block`
          : source.carrier.kind === "summon_at_sight"
            ? `${source.carriersPerCast}× summoned entity`
            : "while the effect is up";
  const when =
    source.trigger.kind === "tick"
      ? `every ${source.trigger.rate} ticks`
      : source.trigger.kind === "expire"
        ? "on expire"
        : source.trigger.kind === "on_hit"
          ? "on hit"
          : "immediately";
  return `${where}, ${when}`;
}

/**
 * Where this source resolves, in a few words — the answer `Origin` exists to give.
 *
 * Worth showing beside a coverage figure, because it is usually the reason for it: a ground
 * effect that reaches nothing at the caster's feet reaches everything when it is laid down on
 * the mob, and the two are the same act with the same radius.
 */
export function originLabel(source: DamageSource): string {
  if (source.origin.atTarget) return "at the enemy hit";
  const last = source.origin.chain[source.origin.chain.length - 1];
  if (last === undefined) return "at the caster";
  if (last.from.kind === "sight") return "where you are looking";
  if (last.from.kind === "target") return "at the enemy hit";
  const parent = source.origin.chain[source.origin.chain.length - 2];
  if (parent === undefined) return "from the caster";
  return parent.carrier.kind === "projectile"
    ? "where its projectile got to"
    : "on what summoned it";
}

function elementOf(value: unknown): ElementName {
  const name = str(value);
  return name !== undefined && name in ELEMENTS ? (name as ElementName) : "Physical";
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * `ProjectileCastHelper.calculateRadius` in the 6.4.13 jar — how far a `FIND_ENEMY` shot looks.
 *
 *     if (lifespanTicks == -1) return 15;
 *     return travelDistance(shootSpeed, lifespanTicks);   // speed * (1 - 0.99^life) / 0.01
 *
 * The fork's checkout says `lifespanTicks * shootSpeed`, which ignores the drag; the jar is what
 * ships. `lifespanTicks` is the act's raw `life_ticks`, before any duration multiplier.
 */
function enemySearchRadius(speed: number, lifeTicks: number): number {
  if (lifeTicks === -1) return 15;
  if (speed <= 0 || lifeTicks <= 0) return 0;
  return (speed * (1 - Math.pow(0.99, lifeTicks))) / 0.01;
}
