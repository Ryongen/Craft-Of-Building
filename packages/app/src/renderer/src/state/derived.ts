/**
 * The one place the engine is called.
 *
 * Everything the UI shows about a build — the sheet, the breakdown, the damage number, the
 * diagnostics — comes out of here, recomputed whenever the document changes. Keeping it to a
 * single module is deliberate: it is what makes moving the work to a Web Worker a one-file
 * change if a build ever gets heavy enough to need it.
 *
 * Measured against the real 2.0.2 snapshot on the level-100 capture, everything below — the stat
 * sheet, the damage figure, the rotation and the defence figure — is ~7 ms for a document the
 * engine has not seen before, and a third of a millisecond for a second ask about the same one.
 *
 * Most of that is the exile-effect fixed point: what is up depends on the sheet (charge caps,
 * `give_exile_effect` grants, buff strengths) and the sheet depends on what is up, so `calculate`
 * runs a pass with nothing applied and then iterates until two answers agree. `resolveEffects`
 * memoises the settled answer against the document object, which is why the four calls here cost
 * one loop between them rather than four. An edit produces a new document and pays it again.
 *
 * Comfortably inside a frame either way, so this runs synchronously on the render path rather
 * than behind a debounce that would make the numbers lag the click that caused them.
 */

import type { Snapshot } from "@cte2/extractor";
import {
  basicAttack,
  calculate,
  defence,
  resources,
  simulateDps,
  simulateFullDps,
  statIndex,
  type BasicAttack,
  type DamageResult,
  type Defence,
  type DpsResult,
  type EffectState,
  type Resources,
  type FullDpsResult,
  type DerivedContribution,
  type EngineResult,
  type EngineStat,
  type ModOrigin,
  type StatContext,
} from "@cte2/engine";
import { isLegal, validateBuild, type BuildDoc, type Diagnostic } from "@cte2/schema";
import { useMemo } from "react";

import { useBuild } from "./build-store.js";
import { useWorld } from "./snapshot.js";

export type ModContribution = {
  /** `GEAR`, `TALENT`, `AURA`, ... */
  ctxType: StatContext["type"];
  /** The registry id that produced it — an item base, a perk, an aura. */
  source: string;
  /** Document path, matching the validator's diagnostic paths. */
  path: string;
  type: "FLAT" | "PERCENT" | "MORE";
  value: number;
  /**
   * Which part of the source produced it, where the collector knows.
   *
   * A `GEAR` context is a whole item, so "chest: +412 armour" is the answer to the wrong
   * question when the chest has a base roll and two armour affixes. This carries the affix, its
   * tier and the roll percent — the last of which is a number no player can read anywhere in
   * game.
   */
  from?: ModOrigin;
};

/** Everything known about one stat, ready to render without further filtering. */
export type StatBreakdown = {
  statId: string;
  stat: EngineStat;
  contributions: ModContribution[];
  derived: DerivedContribution[];
  /** The three running totals the container resolved, reconstructed from the contributions. */
  flat: number;
  percent: number;
  multi: number;
  /**
   * `Stat.base` — the value before anything is added.
   *
   * Zero for all but three stats, and those three matter: `critical_damage` starts at 75,
   * `critical_hit` at 1 and `spirit_cost` at 100. Printing "base 0" for crit damage would make
   * the formula on screen disagree with the number beside it.
   */
  base: number;
  /** What the after-calc passes wrote straight onto the resolved value. */
  addedAfterCalc: number;
  /**
   * Stats this one emptied itself into, if any.
   *
   * `ITransferToOtherStats` hands everything over and then `clear()`s the source, so a stat
   * with entries here reads 0 on the sheet no matter what fed it. `elemental_resist` is the
   * one everybody meets: it is why "+15% all elemental resistance" shows as 0 next to three
   * single resists that went up.
   */
  transferredTo: string[];
};

export type DerivedBuild = {
  doc: BuildDoc;
  /** The character sheet: the no-spell path. */
  stats: Map<string, EngineStat>;
  /**
   * What the build is assumed to have up — the one list every view shares.
   *
   * The main skill's own answer where there is one, because a spell's gates break ties inside an
   * exclusivity group and the sheet was built without knowing which skill would be asked about.
   * Sharing it is the point: a buff turned off in the Config tab has to be the same buff that is
   * off in the Damage tab, off the character's sheet and off the branch it would have enabled.
   */
  effects: EffectState;
  contexts: StatContext[];
  derived: DerivedContribution[];
  /** Validator findings plus everything the engine reported, deduplicated. */
  diagnostics: Diagnostic[];
  legal: boolean;
  /**
   * What it takes to kill you, per element.
   *
   * The same mitigation layers the damage pipeline runs, with the sheets swapped — so it needs no
   * skill and is always present.
   */
  defence: Defence;
  /**
   * Per-second regeneration for every pool, and which one a mana cost actually comes out of.
   *
   * Three kinds of stat feed one number and the third multiplies the first two, so it runs the
   * restore event through the same sweep a hit goes through rather than adding stats up.
   */
  resources: Resources;
  /** Single-hit damage for the main skill, or undefined when no skill is set. */
  damage: DamageResult | undefined;
  /** The same hit plus the cast rate around it. `damage` is `dps.hit`. */
  dps: DpsResult | undefined;
  /** The rotation figure across every skill ticked into Full DPS. Always present. */
  fullDps: FullDpsResult | undefined;
  /**
   * What swinging the weapon is worth, on its own clock.
   *
   * Here rather than computed by whoever wants it, because the topbar's Total DPS includes it and
   * the topbar is not a place to start an engine call from. Handed the sheet that was already
   * computed, so it is the swing's own pipeline and nothing else — see the cost note below.
   *
   * `undefined` for a character holding nothing that swings.
   */
  basic: BasicAttack | undefined;
  /** Wall-clock milliseconds the whole recomputation took, shown in the status bar. */
  elapsedMs: number;
  /** Per-stat provenance, built lazily — only the stat a user opened is assembled. */
  breakdown(statId: string): StatBreakdown;
};

function computeDerived(doc: BuildDoc, snapshot: Snapshot): DerivedBuild {
  const started = performance.now();

  const validation = validateBuild(doc, snapshot);
  const result: EngineResult = calculate(doc, snapshot);
  // Cached per snapshot inside the engine, so this is a map lookup rather than a rebuild.
  const index = statIndex(snapshot);

  // `simulateHit` throws nothing for a legal-but-odd build, but a document mid-edit can name a
  // spell that does not exist yet. A damage panel that disappears beats one that takes the app
  // down, and the validator already says why.
  let damage: DamageResult | undefined;
  let dps: DpsResult | undefined;
  let fullDps: FullDpsResult | undefined;
  let damageDiagnostics: Diagnostic[] = [];
  if ((doc.skills ?? []).length > 0) {
    try {
      // `breakdown` is on because the Damage tab always shows the trace; it is one array push
      // per layer write, which is nothing next to the two stat calculations underneath it.
      // Placement, pack size and any coverage overrides are read from the document by
      // `simulateDps` itself, so there is nothing to thread through here.
      dps = simulateDps(doc, snapshot, { breakdown: true });
      damage = dps?.hit;
      damageDiagnostics = dps?.diagnostics ?? [];
      // Cheap when nothing is ticked, and it re-runs `simulateDps` per ticked skill otherwise.
      // No breakdown: the rotation view shows totals, and the trace belongs to the single skill.
      fullDps = simulateFullDps(doc, snapshot);
      damageDiagnostics = [...damageDiagnostics, ...fullDps.diagnostics];
    } catch (err) {
      damageDiagnostics = [
        {
          severity: "error",
          code: "damage-pipeline-threw",
          path: "skills",
          message: `The damage pipeline failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ];
    }
  }

  // The swing, handed the sheet that is already in hand so it pays for the layer sweep alone and
  // not for a second exile-effect fixed point. It throws on the same half-built documents the
  // damage pipeline does — a weapon whose base no longer exists — and a missing swing is a figure
  // reading 0, not a panel that disappears.
  let basic: BasicAttack | undefined;
  try {
    basic = basicAttack(doc, snapshot, { sheets: { character: result, spell: result } });
  } catch {
    basic = undefined;
  }

  const diagnostics = dedupe([...validation, ...result.diagnostics, ...damageDiagnostics]);
  const elapsedMs = performance.now() - started;

  // Contributions are grouped once, not per stat: a geared character has a few thousand
  // modifiers and the breakdown panel would otherwise rescan them all on every open.
  const byStat = new Map<string, ModContribution[]>();
  for (const ctx of result.contexts) {
    for (const mod of ctx.stats) {
      let list = byStat.get(mod.statId);
      if (!list) {
        list = [];
        byStat.set(mod.statId, list);
      }
      list.push({
        ctxType: ctx.type,
        source: ctx.source,
        path: ctx.path,
        type: mod.type,
        value: mod.value,
        ...(mod.from === undefined ? {} : { from: mod.from }),
      });
    }
  }

  const derivedByStat = new Map<string, DerivedContribution[]>();
  // Transfers are also indexed by their *source*, so a stat can explain why it reads 0.
  const transferredTo = new Map<string, string[]>();
  for (const entry of result.derived) {
    let list = derivedByStat.get(entry.statId);
    if (!list) {
      list = [];
      derivedByStat.set(entry.statId, list);
    }
    list.push(entry);

    if (entry.kind === "transfer") {
      let targets = transferredTo.get(entry.from);
      if (!targets) {
        targets = [];
        transferredTo.set(entry.from, targets);
      }
      if (!targets.includes(entry.statId)) targets.push(entry.statId);
    }
  }

  return {
    doc,
    stats: result.stats,
    effects: dps?.effects ?? result.effects,
    // Handed the sheet that was already computed, so this is the layer sweep and nothing else.
    defence: defence(doc, snapshot, { sheet: result }),
    resources: resources(doc, snapshot, { sheet: result }),
    contexts: result.contexts,
    derived: result.derived,
    diagnostics,
    legal: isLegal(validation),
    damage,
    dps,
    fullDps,
    basic,
    elapsedMs,

    breakdown(statId) {
      const contributions = byStat.get(statId) ?? [];
      const derivedHere = derivedByStat.get(statId) ?? [];

      let flat = 0;
      let percent = 0;
      let multi = 1;
      let addedAfterCalc = 0;

      for (const c of contributions) {
        if (c.type === "FLAT") flat += c.value;
        else if (c.type === "PERCENT") percent += c.value;
        else multi *= 1 + c.value / 100;
      }

      // Transfers and the core-stat pass both re-enter the container, so they belong in these
      // totals; the after-calc passes do not, because they write past it.
      for (const d of derivedHere) {
        if (d.type === "FLAT") flat += d.value;
        else if (d.type === "PERCENT") percent += d.value;
        else if (d.type === "MORE") multi *= 1 + d.value / 100;
        // `addFullyTo` adds to the multiplier rather than multiplying by it — reproduced in
        // the engine, so reproduced here.
        else if (d.type === "MULTI_ADD") multi += d.value;
        else addedAfterCalc += d.value;
      }

      return {
        statId,
        stat: result.stats.get(statId) ?? { value: 0, dmgMulti: 1, hardcap: 0, softcap: 0 },
        contributions,
        derived: derivedHere,
        flat,
        percent,
        multi,
        base: index.shapeOf(statId).base,
        addedAfterCalc,
        transferredTo: transferredTo.get(statId) ?? [],
      };
    },
  };
}

/**
 * Identical findings arrive from more than one source — the validator and the engine both
 * notice an unknown stat id, and `simulateHit` runs `calculate` twice internally.
 */
function dedupe(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of diagnostics) {
    const key = `${d.severity}\0${d.code}\0${d.path}\0${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/**
 * The derived view of the current build.
 *
 * Keyed on document identity: every mutator in the store produces a new object, and nothing
 * mutates one in place, so reference equality is a sound cache key here.
 */
export function useDerived(): DerivedBuild {
  const doc = useBuild((state) => state.doc);
  const { snapshot } = useWorld();
  return useMemo(() => computeDerived(doc, snapshot), [doc, snapshot]);
}
