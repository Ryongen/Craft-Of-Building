/**
 * The weapon swing — the half of a build that presses no button.
 *
 * Every damage figure in this engine used to be a spell's. That was the largest hole in the
 * model and it was not an even one: the pack's melee builds are *built* around basic hits.
 * `ice_tipped_spear` grants `proc_ice_tipped_spear_on_basic_hit` at a flat 100,
 * `whiteout_sovereign` grants `proc_whiteout_sovereign_mini_on_basic_hit` at 30–60, and
 * `hoarfrost_armor` grants `proc_hoarfrost_armor_heal_on_basic_hit` at 25–50. All three reported
 * zero, with the honest reason that nothing knew how often you swing.
 *
 * ## The rate
 *
 *     public double getCurrentItemAttackStrengthDelay() {
 *         return 1.0D / this.getAttributeValue(Attributes.ATTACK_SPEED) * 20.0D;
 *     }
 *
 * — vanilla `Player`, in ticks. So full-strength swings per second is simply the value of
 * `minecraft:generic.attack_speed`, and a player chaining hits waits for the full one because a
 * partial swing is scaled down by `getAttackStrengthScale`.
 *
 * Only **half** of that attribute is derivable from a build document, and the split is the whole
 * story. Mine and Slash's own `attack_speed` stat is an `AttributeStat` with
 * `operation: MULTIPLY_BASE` and `cut_by_hundred: true`, so the total is
 *
 *     (4.0 + the weapon's own ADDITION modifier) × (1 + attack_speed / 100)
 *
 * The right factor is a stat like any other and moves with every edit. The left one is a property
 * of the Minecraft item, not of anything the extractor can see — `possible_items` names
 * `roe_weapons:axe_3` and its attribute modifiers live in that mod's code.
 *
 * Reading the captured attribute back as the rate therefore froze it, because the capture had
 * already baked the character's `attack_speed` into it: stripping every piece of gear took the
 * stat from 40% to 13% and the swing rate did not move. So `character.baseAttackSpeed` records
 * the left factor once — back-filled from a capture, editable for a weapon the capture never
 * held — and the percent is re-applied on every pass. Without it there is still no rate, and
 * {@link BasicAttack.secondsPerSwing} is undefined rather than guessed at.
 *
 * ## The hit
 *
 * `simulateBasicAttack` is the whole of it: the same `DamageEvent`, the same fourteen layers, the
 * same sweep, with `is_basic_atk` set, `weapon_damage` as the base and the character unit as the
 * source sheet. Nothing here re-derives mitigation or conversion.
 */

import type { Snapshot } from "@cte2/extractor";
import type { BuildDoc, Diagnostic, SkillSetup } from "@cte2/schema";

import { resolveEffects, type EngineResult } from "../calculate.js";
import {
  procPlacement,
  simulateDps,
  simulateFullDps,
  type DpsResult,
  type FullDpsResult,
} from "./dps.js";
import { stackAilments, type AilmentStacks } from "./ailments.js";
import { DEFAULT_PLACEMENT } from "./geometry.js";
import type { Sheet } from "./ctx.js";
import type { EffectState } from "./effect-state.js";
import { effectSupply, type EffectSupply } from "./effect-supply.js";
import { resolveProcs, type Proc } from "./procs.js";
import { simulateBasicAttack, type DamageOptions, type DamageResult } from "./simulate.js";

/** Vanilla's own attribute id for how fast a weapon swings. */
export const ATTACK_SPEED_ATTRIBUTE = "minecraft:generic.attack_speed";

export type BasicAttackOptions = DamageOptions & {
  /** Resolve what a swing procs. On by default; a nested call turns it off. */
  procs?: boolean;
  /**
   * What the rest of the build is pressing while you swing, for the procs that spend a debuff.
   *
   * Cryogenic Rupture fires on a swing but only against a Snow-Tracked target, and removes a
   * stack each time, so its rate is whichever is slower: your swings, or whatever keeps putting
   * Snow-Tracked back. Pass the figures already in hand; anything missing is resolved here, and
   * only when some proc on the sheet actually spends a debuff. See `effect-supply.ts`.
   */
  supply?: { main?: DpsResult; rotation?: FullDpsResult };
};

export type BasicAttack = {
  /** One full-strength swing, through the same pipeline a cast goes through. */
  hit: DamageResult;
  /**
   * `minecraft:generic.attack_speed` — full-strength swings per second.
   *
   * Undefined when no capture recorded it, which is the only honest answer: see the note at the
   * top of this file. Every rate below is 0 in that case, and `untimed` says so.
   */
  swingsPerSecond?: number;
  /** `1 / swingsPerSecond`, the delay vanilla makes you wait for a full-strength hit. */
  secondsPerSwing?: number;
  /**
   * True when the rate came from a capture's finished attribute rather than from the weapon's
   * own half times this build's `attack_speed` — so it is right for the captured character and
   * frozen for every edit after it. `character.baseAttackSpeed` is what unfreezes it.
   */
  frozen: boolean;
  /** True when there is no attack-speed attribute to time the swing with. */
  untimed: boolean;
  /**
   * Mine and Slash's own `attack_speed` stat, as a percent.
   *
   * The half a build controls: it multiplies the weapon's base speed rather than replacing it,
   * so it is reported next to the rate rather than used as one.
   */
  attackSpeedPercent: number;
  /** `weapon_damage`, truncated — the base a swing starts from. */
  weaponDamage: number;
  dps: number;
  critDps: number;
  /** Spells a swing casts for you. A `*_on_basic_hit` proc has a rate here and nowhere else. */
  procs: Proc[];
  procDps: number;
  /** Ailment damage per second at full stacks from swinging. Not part of `dps`. */
  ailmentDps: number;
  /** The DoTs that sum to {@link ailmentDps}, one row each. */
  ailmentStacks: AilmentStacks[];
  diagnostics: Diagnostic[];
};

/**
 * What swinging the weapon is worth, per second.
 *
 * Kept separate from {@link simulateDps} rather than folded into it, because a swing and a cast
 * are not on the same clock and never queue behind one another: vanilla's attack cooldown is its
 * own timer and `SpellCastingData.armGlobalCooldown` does not touch it. Adding the two would be
 * claiming a rotation nobody plays; reporting them side by side is what a player can act on.
 */
export function basicAttack(
  build: BuildDoc,
  snapshot: Snapshot,
  options: BasicAttackOptions = {},
): BasicAttack | undefined {
  const pickOptions = {
    ...(options.balanceId === undefined ? {} : { balanceId: options.balanceId }),
    ...(options.baseStatsId === undefined ? {} : { baseStatsId: options.baseStatsId }),
  };

  // The same fixed point every other figure is built on, so a buff that is up for the Damage tab
  // is up here too. No spell gates to break an exclusivity tie — a swing has no branches.
  const characterRun: EngineResult =
    options.sheets?.character ?? resolveEffects(build, snapshot, pickOptions);
  const effects: EffectState = options.effects ?? characterRun.effects;

  const wantProcs = options.procs !== false;
  const hit = simulateBasicAttack(build, snapshot, {
    ...options,
    sheets: { character: characterRun, spell: characterRun },
    effects,
    procs: wantProcs,
  });
  if (!hit) return undefined;

  const diagnostics: Diagnostic[] = [...hit.diagnostics];

  const swings = swingsPerSecond(build, characterRun.stats);
  const untimed = swings === undefined;
  const weaponBase = build.character.baseAttackSpeed;
  // The rate tracks the build only when the weapon's own half is recorded separately. Without it
  // the captured attribute is the whole answer, and the whole answer stopped being true the
  // moment anything moved `attack_speed`.
  const frozen = !untimed && (typeof weaponBase !== "number" || !(weaponBase > 0));

  if (untimed) {
    diagnostics.push({
      severity: "warning",
      code: "basic-attack-untimed",
      path: "character.attributes",
      message:
        `A basic attack's rate is vanilla's 1 / ${ATTACK_SPEED_ATTRIBUTE}, and this build ` +
        `records neither that attribute nor \`character.baseAttackSpeed\` — the weapon's own ` +
        `speed modifier is a Minecraft item property rather than anything the snapshot carries, ` +
        `so it cannot be derived. The hit itself is real; the rate beside it is not. A capture ` +
        `from the companion mod fills it in, or type the weapon's swings per second.`,
    });
  } else if (frozen) {
    diagnostics.push({
      severity: "warning",
      code: "basic-attack-rate-frozen",
      path: "character.baseAttackSpeed",
      message:
        `The swing rate is the ${swings!.toFixed(3)}/s a capture measured, and it will not move ` +
        `when you edit the build: \`attack_speed\` is a MULTIPLY_BASE modifier on that attribute, ` +
        `so the ${(characterRun.stats.get("attack_speed")?.value ?? 0).toFixed(1)}% this build ` +
        `carries is already inside the number. Set \`character.baseAttackSpeed\` to the weapon's ` +
        `own swings per second and the percent is re-applied on every edit.`,
    });
  }

  const dps = hit.average.total * (swings ?? 0);
  const ailmentStacks = stackAilments([{ ailments: hit.average.ailments, hitsPerSecond: swings ?? 0 }]);
  const critDps = hit.crit.total * (swings ?? 0);

  const procs =
    hit.procs === undefined
      ? []
      : resolveProcs({
          snapshot,
          build,
          effects,
          onHit: hit.procs.onHit,
          onCrit: hit.procs.onCrit,
          critChance: hit.critChance,
          hitsPerSecond: swings ?? 0,
          sheet: characterRun.stats,
          // A swing carries no spell, so every `spell_has_tag` gate on a proc correctly fails.
          spellTags: new Set<string>(),
          damageOf: (spellId, position) => {
            const entryData = snapshot.registries["mmorpg_spells"]?.[spellId]?.data;
            if (!entryData) return 0;
            const procSkill: SkillSetup = (build.skills ?? []).find((s) => s.spellId === spellId) ?? {
              spellId,
            };
            const result = simulateDps(build, snapshot, {
              ...options,
              skill: procSkill,
              procs: false,
              // The same placement `simulateDps` would have read, with the enemy moved to the
              // origin when the proc is cast from it.
              placement: procPlacement(build.config?.target ?? DEFAULT_PLACEMENT, position),
            });
            return result?.damagePerCast ?? 0;
          },
          supplyOf: (effectId) => supplyFor(build, snapshot, effectId, options),
          diagnostics,
        });

  return {
    hit,
    ...(swings === undefined ? {} : { swingsPerSecond: swings, secondsPerSwing: 1 / swings }),
    untimed,
    frozen,
    attackSpeedPercent: characterRun.stats.get("attack_speed")?.value ?? 0,
    weaponDamage: hit.baseValue,
    dps,
    critDps,
    procs,
    procDps: procs.reduce((sum, p) => sum + p.dps, 0),
    // Every swing adds its own bleed, burn or poison to the stack, so this is the full-stacks rate.
    ailmentDps: ailmentStacks.reduce((sum, s) => sum + s.dps, 0),
    ailmentStacks,
    diagnostics,
  };
}

/**
 * The debuff supply for a swing's consuming procs, on the figures the caller had or could get.
 *
 * Every nested call has its own procs and grants off: the question is how fast a skill *casts*,
 * and a skill's procs neither speed it up nor apply anything a consumer here could spend.
 */
function supplyFor(
  build: BuildDoc,
  snapshot: Snapshot,
  effectId: string,
  options: BasicAttackOptions,
): EffectSupply {
  const nested = {
    ...(options.balanceId === undefined ? {} : { balanceId: options.balanceId }),
    ...(options.baseStatsId === undefined ? {} : { baseStatsId: options.baseStatsId }),
    procs: false,
    granted: false,
    summons: false,
  };
  const ticked = (build.skills ?? []).some((s) => s.includeInFullDps === true);
  const rotation =
    options.supply?.rotation ?? (ticked ? simulateFullDps(build, snapshot, nested) : undefined);
  const main = options.supply?.main ?? simulateDps(build, snapshot, nested);
  return effectSupply(build, snapshot, effectId, {
    ...(main === undefined ? {} : { main }),
    ...(rotation === undefined ? {} : { rotation }),
    resolve: (skill) => simulateDps(build, snapshot, { ...nested, skill }),
  });
}

/**
 * Full-strength swings per second, or undefined when the document cannot say.
 *
 * `baseAttackSpeed × (1 + attack_speed / 100)` wherever the weapon's own rate is recorded, which
 * is what makes the figure move when the build does. Falling back to the raw captured attribute
 * is correct only for the character that was captured, and {@link basicAttack} says so.
 *
 * Exported because more than the damage figure wants it: `combo.ts` times a chain that ends at a
 * basic attack with the same number, and the two must never disagree.
 */
export function swingsPerSecond(build: BuildDoc, sheet?: Sheet): number | undefined {
  const base = build.character.baseAttackSpeed;
  if (typeof base === "number" && Number.isFinite(base) && base > 0 && sheet !== undefined) {
    // `cut_by_hundred`, then `MULTIPLY_BASE`: vanilla multiplies the post-ADDITION base by
    // `1 + the sum of the multipliers`. A character with -100% or worse cannot swing at all.
    const percent = sheet.get("attack_speed")?.value ?? 0;
    return Math.max(0, base * (1 + percent / 100));
  }
  const declared = build.character.attributes?.[ATTACK_SPEED_ATTRIBUTE];
  return typeof declared === "number" && Number.isFinite(declared) && declared > 0
    ? declared
    : undefined;
}

/**
 * The weapon's own swing rate, backed out of a capture.
 *
 * `total / (1 + attack_speed / 100)`, which inverts the `MULTIPLY_BASE` above. Only sound while
 * the document still describes the character the attribute was measured on — so the app calls it
 * when a capture is opened and never again.
 */
export function baseAttackSpeedFrom(total: number, attackSpeedPercent: number): number | undefined {
  const multi = 1 + attackSpeedPercent / 100;
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(multi) || multi <= 0) return undefined;
  return total / multi;
}
