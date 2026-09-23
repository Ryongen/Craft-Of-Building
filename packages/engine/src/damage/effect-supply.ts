/**
 * How fast the build puts a debuff on the target — for the procs that spend one.
 *
 * `proc_ice_tipped_spear_on_basic_hit` is the shape this exists for:
 *
 *     effects: proc_spell_ice_tipped_spear_stun, remove_snow_tracked_from_target
 *     ifs:     ..., is_target_under_snow_tracked, is_is_basic_atk_true, ...
 *
 * Cryogenic Rupture needs a Snow-Tracked target and takes one stack off it every time it fires
 * (`remove_exile_effect`, `stacks: 1`). Its own cooldown is one tick, so the only thing standing
 * between it and "every swing" is how often something puts Snow-Tracked back — and that is a
 * different skill entirely. Reading the gate as a plain yes/no let it fire on all 5.2 swings a
 * second of the reference build when Tailwind Sweep, the skill that applies it, lands 2.5 a
 * second.
 *
 * ## Whose casts
 *
 * A static document says which skills *can* apply the debuff, not which you are pressing, so the
 * answer takes a stated basis and reports it:
 *
 *  - **rotation** — the skills ticked into Full DPS, at the rate the rotation presses them. The
 *    document has said what you press, so this is the one to believe.
 *  - **main** — the main skill, when it applies the debuff itself. The skill you spam is the one
 *    that keeps the target marked.
 *  - **bar** — otherwise the fastest applier on the bar, on its own cycle. This is the case of a
 *    buff (Ice-Tipped Blade) asked about on its own: the build clearly has something that marks
 *    targets, and reporting zero because the question was about the buff would be wrong.
 *  - **none** — nothing on the bar applies it.
 *
 * ## Stacks per cast
 *
 * Read off {@link SkillModel.applications}, the same walk and firing count a damage source gets.
 * One judgement call, stated: a pulse that re-applies faster than once a second (`glacial_dash`
 * puts three stacks on every tick of its dash) is refreshing the stacks already there, not
 * handing a consumer new ones — so one carrier of it is worth at most `max_stacks`. A slower pulse
 * (`banner_of_the_hunt`, every 30 ticks) is counted in full, because a swing can spend a stack
 * between two of them.
 *
 * Every application is assumed to land when the skill reaches the target at all — the same
 * clear-sight default the damage geometry uses.
 */

import type { Snapshot } from "@cte2/extractor";
import type { BuildDoc, SkillSetup } from "@cte2/schema";
import { CATEGORY, entry, isSkillEnabled } from "@cte2/schema";

import type { DpsResult, FullDpsResult } from "./dps.js";
import { grantsToTarget } from "./effect-state.js";
import { TICKS_PER_SECOND } from "./spell-calc.js";

export type SupplyBasis = "rotation" | "main" | "bar" | "none";

export type SupplySource = {
  spellId: string;
  /** Stacks one press leaves on the target. */
  stacksPerCast: number;
  /** Presses per second on this basis — the skill's own cycle, or the rotation's share of it. */
  castsPerSecond: number;
  stacksPerSecond: number;
};

export type EffectSupply = {
  effectId: string;
  /** Stacks per second arriving on the target, summed over {@link from}. */
  stacksPerSecond: number;
  basis: SupplyBasis;
  from: SupplySource[];
};

export type SupplyContext = {
  /** The main skill's figure, when the caller has it. */
  main?: DpsResult;
  /** The Full DPS rotation, when the caller has it and anything is ticked into it. */
  rotation?: FullDpsResult;
  /** Resolves one skill on the bar, for the `bar` basis. Called only for skills that apply it. */
  resolve: (skill: SkillSetup) => DpsResult | undefined;
};

/** How many stacks one press of this skill leaves on the target. */
export function stacksPerCast(snapshot: Snapshot, result: DpsResult, effectId: string): number {
  // A skill that reaches nothing where the target stands applies nothing to it either. A skill
  // with no damage at all (a banner) has no geometry to ask, and is given the benefit of it.
  const reaches =
    result.sources.length === 0 || result.sources.some((s) => s.coverage.hitsPerCast > 0);
  if (!reaches) return 0;

  const max = maxStacksOf(snapshot, effectId);
  let total = 0;
  for (const app of result.model.applications) {
    if (app.effectId !== effectId) continue;
    const perFiring = Math.min(app.stacks, max);
    const refreshing =
      app.trigger.kind === "tick" && app.trigger.rate < TICKS_PER_SECOND && app.firesPerCarrier > 1;
    const perCarrier = refreshing
      ? Math.min(perFiring * app.firesPerCarrier, max)
      : perFiring * app.firesPerCarrier;
    total += perCarrier * app.carriersPerCast * app.castShare;
  }
  return total;
}

/** Stacks per second of `effectId` the build puts on the target, and on what basis. */
export function effectSupply(
  build: BuildDoc,
  snapshot: Snapshot,
  effectId: string,
  context: SupplyContext,
): EffectSupply {
  const none: EffectSupply = { effectId, stacksPerSecond: 0, basis: "none", from: [] };

  const rotation = context.rotation;
  if (rotation !== undefined && rotation.skills.length > 0 && rotation.rotationSeconds > 0) {
    const from: SupplySource[] = [];
    for (const entry of rotation.skills) {
      const stacks = stacksPerCast(snapshot, entry.result, effectId);
      if (stacks <= 0) continue;
      const presses = entry.role === "rotation" ? 1 : (entry.pressesPerRotation ?? 0);
      const castsPerSecond = (presses * entry.result.rate.castsPerCycle) / rotation.rotationSeconds;
      from.push({ spellId: entry.skill.spellId, stacksPerCast: stacks, castsPerSecond, stacksPerSecond: stacks * castsPerSecond });
    }
    if (from.length > 0) return summed(effectId, "rotation", from);
  }

  const main = context.main;
  if (main !== undefined) {
    const own = sourceOf(snapshot, main, effectId);
    if (own !== undefined) return summed(effectId, "main", [own]);
  }

  let best: SupplySource | undefined;
  for (const skill of build.skills ?? []) {
    if (!isSkillEnabled(skill)) continue;
    if (main !== undefined && skill.spellId === main.spellId) continue;
    const spell = entry(snapshot, CATEGORY.spell, skill.spellId)?.data;
    if (spell === undefined || !grantsToTarget(spell, effectId)) continue;
    const result = context.resolve(skill);
    if (result === undefined) continue;
    const candidate = sourceOf(snapshot, result, effectId);
    if (candidate !== undefined && (best === undefined || candidate.stacksPerSecond > best.stacksPerSecond)) {
      best = candidate;
    }
  }
  return best === undefined ? none : summed(effectId, "bar", [best]);
}

function sourceOf(snapshot: Snapshot, result: DpsResult, effectId: string): SupplySource | undefined {
  const stacks = stacksPerCast(snapshot, result, effectId);
  const cycle = result.rate.cycleSeconds;
  if (stacks <= 0 || !(cycle > 0)) return undefined;
  const castsPerSecond = result.rate.castsPerCycle / cycle;
  return { spellId: result.spellId, stacksPerCast: stacks, castsPerSecond, stacksPerSecond: stacks * castsPerSecond };
}

function summed(effectId: string, basis: SupplyBasis, from: SupplySource[]): EffectSupply {
  return {
    effectId,
    basis,
    from,
    stacksPerSecond: from.reduce((sum, s) => sum + s.stacksPerSecond, 0),
  };
}

/** `ExileEffect.max_stacks`; 1 for an effect that declares none, which is how the game reads it. */
function maxStacksOf(snapshot: Snapshot, effectId: string): number {
  const value = entry(snapshot, CATEGORY.exileEffect, effectId)?.data?.["max_stacks"];
  return typeof value === "number" && value >= 1 ? value : 1;
}
