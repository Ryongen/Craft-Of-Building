/**
 * The five ailments.
 *
 * They are **not** in any registry: `ExileRegistryTypes.java:94` registers the type with
 * `SyncTime.NEVER` and `Ailments.java` constructs all five in Java. The snapshot confirms it
 * from the other side — there is no `mmorpg_ailment` category, only a `registryLists` entry
 * naming the five ids. So this table is ported by hand, like the code-only stats.
 *
 * ## An ailment is a second damage event
 *
 * `AilmentChance.activate` builds a whole new `DamageEvent` with `disableActivation = true` —
 * it runs the entire pipeline purely to arrive at a number, and never deals that damage
 * itself. The number is then handed to `onAilmentCausingDamage`, which is where duration,
 * resistance and stacking happen.
 *
 * ## A DoT tick is not a hit
 *
 * `onTick` fires the accumulated damage with `calcSourceEffects = calcTargetEffects = false`
 * (EntityAilmentData.java:190-226): a tick skips the stat sweep entirely, so none of the
 * attacker's damage stats and none of the target's mitigation apply to it a second time. They
 * were already applied when the ailment was inflicted.
 */

import type { ElementName } from "@cte2/schema";

import { EVENT } from "./event.js";
import { sheetValue, type DamageCtx, type Sheet } from "./ctx.js";

export type Ailment = {
  id: string;
  element: ElementName;
  isDot: boolean;
  isStrengthEffect: boolean;
  /** `damageEffectivenessMulti`. */
  damageMulti: number;
  /** `percentLostEveryXSeconds` — decay for the two strength ailments. */
  percentLostPerInterval: number;
  durationTicks: number;
  /** `percentHealthRequiredForFullStrength`, defaulted to 0.25 by the constructor. */
  percentHealthForFullStrength: number;
};

/** `Ailments.java:14-20`, argument order `(id, element, isDot, isStrength, dmgMulti, %lost, ticks)`. */
export const AILMENTS: readonly Ailment[] = [
  { id: "burn", element: "Fire", isDot: true, isStrengthEffect: false, damageMulti: 1, percentLostPerInterval: 0, durationTicks: 60, percentHealthForFullStrength: 0.25 },
  { id: "poison", element: "Shadow", isDot: true, isStrengthEffect: false, damageMulti: 1.5, percentLostPerInterval: 0, durationTicks: 200, percentHealthForFullStrength: 0.25 },
  { id: "bleed", element: "Physical", isDot: true, isStrengthEffect: false, damageMulti: 1.2, percentLostPerInterval: 0, durationTicks: 100, percentHealthForFullStrength: 0.25 },
  { id: "freeze", element: "Cold", isDot: false, isStrengthEffect: true, damageMulti: 0.85, percentLostPerInterval: 0.1, durationTicks: 0, percentHealthForFullStrength: 0.25 },
  { id: "electrify", element: "Nature", isDot: false, isStrengthEffect: true, damageMulti: 1, percentLostPerInterval: 0.1, durationTicks: 0, percentHealthForFullStrength: 0.25 },
];

export type AilmentResult = {
  ailment: string;
  element: ElementName;
  /** Probability the hit inflicted it — `<ailment>_chance` as a fraction. */
  chance: number;
  /** Damage per second while it ticks. Zero for the two non-DoT ailments. */
  damagePerSecond: number;
  /** Total over its full duration, before any refresh. */
  totalDamage: number;
  durationSeconds: number;
  /** Accumulated pool for `freeze` and `electrify`, released by a shatter/shock proc. */
  accumulated: number;
  /**
   * The base the hit handed the ailment, before its own event ran.
   *
   * `originalNumber + appliedFlatDamage`, scaled by however much of the hit converted away.
   * Reported next to the figure because the gap between this and what the ailment actually
   * inflicts is the whole of what `ailment_damage` and its family are worth.
   */
  hitBase: number;
  /** What the ailment's own `DamageEvent` turned {@link hitBase} into. */
  eventDamage: number;
};

/**
 * Runs the ailment's own `DamageEvent` and returns the number it arrives at.
 *
 * Injected rather than imported: the event machinery lives in `simulate.ts`, which already calls
 * this file, and a second edge between them would be a cycle. A caller with no pipeline to hand
 * omits it and gets the old arithmetic, which is the floor.
 */
export type AilmentEventRunner = (ailment: Ailment, base: number) => number;

/**
 * `AilmentChance.Effect` at `FINAL_DAMAGE` (100), Source side, for each of the five.
 *
 * The base is deliberately *not* the final damage:
 *
 *     float dmg = effect.data.getOriginalNumber(EventData.NUMBER).number + effect.getAppliedFlatDamage();
 *     float convMulti = effect.unconvertedDamagePercent / 100F;
 *     dmg *= convMulti;
 *
 * — AilmentChance.java:74-86. It is the *pre-multiplier* number plus whatever the flat-damage
 * layer added, scaled down by however much of the hit converted away. Reading the final number
 * instead would double-dip every increase and multiplier the hit already applied.
 */
export function applyAilments(
  ctx: DamageCtx,
  source: Sheet,
  target: Sheet,
  runEvent?: AilmentEventRunner,
): AilmentResult[] {
  const out: AilmentResult[] = [];
  const event = ctx.event;

  // `canActivate` — the gates that do not depend on the roll.
  if (event.damage <= 0) return out;
  if (event.unconvertedDamagePercent <= 0) return out;
  if (event.data.getBoolean(EVENT.IS_DODGED) || event.data.getBoolean(EVENT.IS_BLOCKED)) return out;

  const attackType = event.data.getString(EVENT.ATTACK_TYPE, "hit");
  if (attackType !== "hit" && attackType !== "bonus_dmg") return out;

  const element = event.data.getElement();
  const base =
    (event.data.getOriginalNumber(EVENT.NUMBER) + event.appliedFlatDamage) *
    (event.unconvertedDamagePercent / 100);
  if (base <= 0) return out;

  for (const ailment of AILMENTS) {
    // `effect.getElement() == ailment.element` — an ailment only comes from its own element.
    if (ailment.element !== element) continue;

    const chance = clamp01(sheetValue(source, `${ailment.id}_chance`) / 100);
    if (chance <= 0) continue;

    out.push(resolve(ctx, ailment, base, chance, source, target, runEvent));
  }

  return out;
}

/**
 * `EntityAilmentData.onAilmentCausingDamage` (EntityAilmentData.java:78-165).
 *
 *     dmg = dmg * ailment.damageEffectivenessMulti;
 *     dmg *= unit.getCalculatedStat(eff).getMultiplier();          // <ailment>_strength
 *     dmg *= resist.getReverseMultiplier();                        // <ailment>_resistance, 1 - v/100
 *     if (ailment.isDot) { dmg *= 1F / (durationTicks / 20F); }    // per-second amortisation
 *     if (ailment.isDot) {
 *         dmg *= speed;                                            // dot_speed
 *         int ticks = ailment.durationTicks;
 *         ticks /= speed;
 *         ticks *= unit.getCalculatedStat(dur).getMultiplier();     // <ailment>_duration
 *         if (ticks < 21) { ticks = 21; }
 *     }
 *
 * `dot_speed` cuts both ways on purpose: it raises damage per second and shortens the duration
 * by the same factor, so total damage is unchanged and only the delivery rate moves. The
 * duration multiplier applied afterwards is what actually adds total damage.
 *
 * **The number handed in is the ailment's own event, not the hit's.** `AilmentChance.activate`
 * builds a whole second `DamageEvent` and runs it before any of the arithmetic above:
 *
 *     var event = EventBuilder.ofDamage(source, target, dmg)
 *             .setupDamage(AttackType.dot, WeaponTypes.none, PlayStyle.INT)
 *             .set(x -> { x.disableActivation = true; x.setElement(ailment.element);
 *                         x.setisAilmentDamage(ailment); ... }).build();
 *     event.Activate();
 *     Load.Unit(target).ailments.onAilmentCausingDamage(source, target, ailment,
 *             event.data.getNumber(), unit);
 *
 * `disableActivation` means it never deals that damage — the event exists purely to arrive at a
 * number — but `Activate()` runs the full sweep on the way, both sides. That is how
 * `AilmentDamage` and `AllAilmentDamage` (both writing into `additive_damage`) reach a DoT at
 * all, along with `total_damage`, `all_<element>_damage` and the target's own mitigation layers.
 * Without it every ailment figure was a floor, missing 20 pack references to `ailment_damage`
 * alone.
 *
 * Three things about that second event decide which stats it picks up, and all three are the
 * builder's rather than the hit's: its attack type is `dot`, not `hit`, so nothing gated on a hit
 * applies and it cannot inflict an ailment of its own; its weapon type is `none`; and its style
 * is `int` **whatever weapon you are holding**, which is `PlayStyle.INT` written as a literal in
 * `AilmentChance.activate`. Crit is not carried over either — the builder never sets it.
 */
function resolve(
  ctx: DamageCtx,
  ailment: Ailment,
  hitBase: number,
  chance: number,
  source: Sheet,
  target: Sheet,
  runEvent: AilmentEventRunner | undefined,
): AilmentResult {
  const strength = 1 + sheetValue(source, `${ailment.id}_strength`) / 100;
  const resistance = 1 - sheetValue(target, `${ailment.id}_resistance`) / 100;
  const speed = 1 + sheetValue(source, "dot_speed") / 100;
  const duration = 1 + sheetValue(source, `${ailment.id}_duration`) / 100;

  // `event.data.getNumber()` after `Activate()`. Without a runner this is the old floor, which
  // is the pre-layer number and therefore never larger.
  const eventDamage = runEvent === undefined ? hitBase : runEvent(ailment, hitBase);

  let dmg = eventDamage * ailment.damageMulti * strength * resistance;

  if (!ailment.isDot) {
    // `freeze` and `electrify` accumulate into a pool released by a shatter or shock proc
    // rather than ticking. The strength half of that (the chill slow tier) is a movement
    // effect, not damage, so it is not modelled here.
    return {
      ailment: ailment.id,
      element: ailment.element,
      chance,
      damagePerSecond: 0,
      totalDamage: dmg,
      durationSeconds: 0,
      accumulated: dmg,
      hitBase,
      eventDamage,
    };
  }

  // `1F / (durationTicks / 20F)` — spread the hit's worth over the ailment's whole duration.
  dmg *= 1 / (ailment.durationTicks / 20);
  dmg *= speed;

  // Integer arithmetic in Java: `int ticks` is truncated at each step.
  let ticks = ailment.durationTicks;
  ticks = Math.trunc(ticks / speed);
  ticks = Math.trunc(ticks * duration);
  if (ticks < 21) ticks = 21;

  const seconds = ticks / 20;
  return {
    ailment: ailment.id,
    element: ailment.element,
    chance,
    damagePerSecond: dmg,
    totalDamage: dmg * seconds,
    durationSeconds: seconds,
    accumulated: 0,
    hitBase,
    eventDamage,
  };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
