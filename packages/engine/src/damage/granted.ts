/**
 * Spells a skill hands you: the procs its own buff puts on your sheet.
 *
 * Ice-Tipped Blade deals no damage. Pressing it puts `ice_tipped_spear` on you, and that effect
 * carries `proc_ice_tipped_spear_on_basic_hit` at a flat 100 — so everything the skill is worth
 * is Cryogenic Rupture, fired off your swings. Its `DpsResult.dps` is 0 and correctly so, which
 * left its row on the Skills tab reading 0, the support gem ranking with nothing to sort by, and
 * the one number that actually describes the button nowhere.
 *
 * Thirteen skills in this pack do it: the buff grants a proc stat, and the proc is another spell
 * (`use_support_gems_from` usually points back at the skill, so its gems are the proc's gems).
 * They trigger on two clocks:
 *
 *  - **the swing** — `ice_tipped_spear`, `whiteout_sovereign`, `hoarfrost_armor`, `zen`. Rated
 *    by `basic-attack.ts`, which already knows how often you swing and what a debuff-spending
 *    proc is limited by.
 *  - **a cast** — `frost_blade`, `galvanic_blade`, `banishing_blade`, `arachnid_inoculation`.
 *    Rated off whatever you are pressing, which is the main skill's own proc list.
 *
 * This file picks the granted ones out of those two lists. It computes no proc itself: the chance,
 * the cooldown and the supply are all the proc pipeline's, and a second derivation here would be
 * a second chance for the Skills tab to disagree with the Damage tab.
 *
 * These are **attribution, not new damage**. The swing's procs are already in Total DPS through
 * the basic attack, and a cast proc through the skill that triggered it. `grantedDps` exists so a
 * buff's row and its gem ranking have the number that moves; adding it to a total would count
 * Cryogenic Rupture twice.
 */

import type { Snapshot } from "@cte2/extractor";
import type { BuildDoc } from "@cte2/schema";
import { CATEGORY, entry } from "@cte2/schema";

import type { EngineResult } from "../calculate.js";
import { basicAttack } from "./basic-attack.js";
import { simulateDps } from "./dps.js";
import { casterEffectsOf } from "./effect-state.js";
import type { Proc } from "./procs.js";
import { TICKS_PER_SECOND } from "./spell-calc.js";

/** The proc stats this spell's self-applied effects carry, keyed to whether only a swing fires them. */
export function grantedProcStats(snapshot: Snapshot, spellId: string): Map<string, { basicOnly: boolean }> {
  const out = new Map<string, { basicOnly: boolean }>();
  const spell = entry(snapshot, CATEGORY.spell, spellId)?.data;
  if (spell === undefined) return out;
  const statEffects = snapshot.registries[CATEGORY.statEffect] ?? {};

  for (const effectId of casterEffectsOf(spell)) {
    const stats = entry(snapshot, CATEGORY.exileEffect, effectId)?.data?.["stats"];
    if (!Array.isArray(stats)) continue;
    for (const raw of stats) {
      const statId = (raw as Record<string, unknown>)["stat"];
      if (typeof statId !== "string" || out.has(statId)) continue;
      const blocks = entry(snapshot, CATEGORY.stat, statId)?.data?.["effect"];
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks as Record<string, unknown>[]) {
        const ids = Array.isArray(block["effects"]) ? block["effects"] : [];
        const procs = ids.some(
          (id) => typeof id === "string" && statEffects[id]?.data?.["ser"] === "proc_spell",
        );
        if (!procs) continue;
        const ifs = Array.isArray(block["ifs"]) ? block["ifs"] : [];
        out.set(statId, { basicOnly: ifs.includes("is_is_basic_atk_true") });
        break;
      }
    }
  }
  return out;
}

export type GrantedInput = {
  build: BuildDoc;
  snapshot: Snapshot;
  spellId: string;
  /** The character run the skill was measured on, so the swing does not settle a second one. */
  characterRun: EngineResult;
  balanceId?: string;
  baseStatsId?: string;
};

/**
 * The procs this skill's buff grants, each rated on the clock that fires it.
 *
 * Empty for a skill whose buff grants none, which is all but thirteen — and then nothing below
 * runs, so the ordinary skill pays for one registry walk.
 */
export function grantedProcs(input: GrantedInput): Proc[] {
  const granted = grantedProcStats(input.snapshot, input.spellId);
  if (granted.size === 0) return [];

  const pick = {
    ...(input.balanceId === undefined ? {} : { balanceId: input.balanceId }),
    ...(input.baseStatsId === undefined ? {} : { baseStatsId: input.baseStatsId }),
  };

  const swing = basicAttack(input.build, input.snapshot, {
    ...pick,
    sheets: { character: input.characterRun, spell: input.characterRun },
  });
  const fromSwing = (swing?.procs ?? []).filter((p) => granted.has(p.statId));

  // The cast clock is only worth a pass when something granted can fire on it. And never this
  // skill's own casts: those procs are already in its `procDps`, and attributing them twice would
  // rank a gem twice for the same damage.
  const castable = [...granted.values()].some((g) => !g.basicOnly);
  const main = castable ? simulateDps(input.build, input.snapshot, { ...pick, granted: false }) : undefined;
  const fromCast =
    main === undefined || main.spellId === input.spellId
      ? []
      : main.procs.filter((p) => granted.has(p.statId));

  return merge(fromSwing, fromCast).sort((a, b) => b.dps - a.dps);
}

/**
 * One row per proc across both clocks.
 *
 * `banishing_blade`'s Soul Wound fires on a swing *or* a melee cast, and its cooldown is one
 * ceiling over both — so the rates add and are then capped, never capped and then added.
 */
function merge(a: readonly Proc[], b: readonly Proc[]): Proc[] {
  const out = new Map<string, Proc>();
  for (const proc of [...a, ...b]) {
    const key = `${proc.statId}:${proc.spellId}`;
    const seen = out.get(key);
    if (seen === undefined) {
      out.set(key, proc);
      continue;
    }
    const capPerSecond = TICKS_PER_SECOND / Math.max(1, seen.cooldownTicks);
    const supplyCap =
      seen.consumes === undefined
        ? Number.POSITIVE_INFINITY
        : seen.consumes.supply.stacksPerSecond / seen.consumes.stacksPerProc;
    const perSecond = Math.min(seen.perSecond + proc.perSecond, capPerSecond, supplyCap);
    const damagePerProc = Math.max(seen.damagePerProc, proc.damagePerProc);
    const { limit: _limit, ...rest } = seen;
    const limit = seen.limit !== undefined && proc.limit !== undefined ? seen.limit : undefined;
    out.set(key, {
      ...rest,
      triggersPerSecond: seen.triggersPerSecond + proc.triggersPerSecond,
      perSecond,
      damagePerProc,
      dps: damagePerProc * perSecond,
      ...(limit === undefined ? {} : { limit }),
    });
  }
  return [...out.values()];
}
