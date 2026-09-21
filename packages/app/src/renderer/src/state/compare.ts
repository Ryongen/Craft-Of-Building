/**
 * What would happen if.
 *
 * Path of Building's best idea is not the damage number — it is that every choice is priced
 * before you make it. The support gem list is ordered by what each gem would add, and hovering a
 * passive tells you what taking it would do, so you are choosing between numbers rather than
 * between names. This is the module that prices a choice.
 *
 * It is the second place the engine is called, and deliberately a *different* place from
 * `derived.ts`. That module answers "what is this build", once per edit, on the render path.
 * This one answers "what would this build be", many times per interaction, for documents the
 * user has not committed to and may never commit to. Keeping them apart is what lets the
 * expensive one be scheduled: see `useRanking`.
 *
 * ## What a candidate costs
 *
 * A full recomputation — sheet, damage, rotation, swing and defence — is 7 to 12 ms against the
 * real 2.0.2 snapshot on a level-100 character. That is fine once on hover and not fine ninety
 * times in a row on the render path, so {@link useRanking} slices the work across frames and
 * publishes partial results as they land. The list is useful from the first chunk.
 *
 * ## Why the whole document is rebuilt rather than patched
 *
 * A support gem changes the spell unit, which changes the rate, which changes the resource
 * budget. A passive changes the character sheet, which changes which exile effects are
 * available, which changes which branch of the skill exists. Neither can be answered by adding a
 * number to a total — the only honest way to price a change is to compute the build that has it.
 */

import type { Snapshot } from "@cte2/extractor";
import {
  basicAttack,
  calculate,
  defence,
  simulateDps,
  simulateFullDps,
  type BasicAttack,
  type Defence,
  type DpsResult,
  type EngineResult,
  type EngineStat,
  type FullDpsResult,
} from "@cte2/engine";
import {
  fillTemplate,
  statDisplay,
  statNameRaw,
  stripFormatting,
  type BuildDoc,
  type StatDisplay,
} from "@cte2/schema";
import { useEffect, useMemo, useRef, useState } from "react";

import { useBuild, type Baseline } from "./build-store.js";
import { useDerived, type DerivedBuild } from "./derived.js";
import { useWorld } from "./snapshot.js";

/**
 * The figures a choice is judged on.
 *
 * Offence and defence together, because a passive that buys damage by giving up life is the
 * commonest trade on a tree and a panel that only showed one half would recommend it.
 */
export type Vitals = {
  /** The main skill, on its own button. */
  dps: number;
  critDps: number;
  /**
   * The rotation across every skill ticked into Full DPS — procs and ailments included.
   *
   * A buff ticked into it is charged its upkeep rather than a cast per pass, so putting one on
   * the bar raises this figure instead of diluting it.
   *
   * Ailments are in it so that this, the sidebar's Full DPS row and the Damage tab's Full DPS
   * figure are one number under one name. They were three compositions of it, and a Shatter
   * build's whole cold output fell out of two of them.
   */
  fullDps: number;
  /**
   * Spells the build casts for you while you play.
   *
   * The rotation's merged list where a rotation is ticked, the main skill's otherwise — the same
   * choice `totalDps` makes, so the two can never disagree about which procs are being counted.
   * Already inside {@link fullDps}.
   */
  procDps: number;
  /** Ailments the rotation, or the main skill, inflicts. On their own clock, never part of `dps`. */
  ailmentDps: number;
  /** The weapon swing, which has its own clock too — see `damage/basic-attack.ts`. */
  basicDps: number;
  /**
   * What the pets are doing, which for nineteen of this pack's skills is the entire output.
   *
   * A `summon_zombie` bar declares no `damage` act at all, so its `dps` is 0 and everything it
   * actually does sits here. A comparison that left this out priced every minion build at zero
   * and reported that no change to one ever mattered.
   */
  summonDps: number;
  /**
   * Everything that lands on the target while you play this build, per second.
   *
   * The sum of the four rates above with the rotation standing in for the single skill where
   * there is one. It is the headline because it is the only figure that moves for *every* kind
   * of choice: a gem that adds nothing to the hit but doubles the proc rate is invisible in
   * `dps` and real here.
   */
  totalDps: number;
  critChance: number;
  /**
   * How often the asked-about skill's button comes back, in seconds.
   *
   * Here because a third of this pack's "skills" deal no damage at all, and for those every
   * figure above is 0 — so a support gem linked to Protection moved nothing a comparison could
   * see, and the ranked list reported all ninety gems as having no effect on it. Cooldown is
   * what a Cooldown gem buys, and it is real whether or not the button also hurts anything.
   */
  skillCycleSeconds: number;
  /**
   * How long one press of the asked-about skill keeps its buff on you, in seconds.
   *
   * 0 when there is nothing to report, which covers both "this skill buffs nobody" and "this
   * buff is a toggle" — a toggle's duration is the `-1` sentinel and no amount of Effect
   * Duration lengthens it, so a row saying it moved would be a row saying something false. The
   * two cases are 0 together because a comparison only ever reads the difference, and neither
   * one can produce one.
   */
  buffSeconds: number;
  /**
   * Life plus magic shield, before any mitigation.
   *
   * Beside {@link ehp} rather than folded into it, because the two move independently and which
   * one moved is the useful part: buying life raises both, buying resistance raises only the
   * effective figure. A comparison showing `EHP +18%` alone cannot tell you which you bought.
   */
  pool: number;
  /** What kills you first, and how much raw damage of it you survive. */
  ehp: number;
  weakestElement: string;
  /** Effective HP per element, so a resist change shows up where it happened. */
  ehpByElement: { element: string; effectiveHealth: number }[];
  /** The character sheet, for the "and everything else that moved" list. */
  stats: ReadonlyMap<string, number>;
  /**
   * `IUsableStat.getUsableValue` per stat that has one — armour, dodge, spell dodge, block and
   * the resists.
   *
   * Beside {@link stats} rather than replacing the entry in it, because the two answer different
   * questions and a diff wants both: `+120 armour` is what the item gave you and `+1.4%
   * mitigation` is what it bought. Carried rather than recomputed at the point of rendering,
   * because the curve needs the character's level, the balance file and the stat's scaling class
   * — all of which are inside the engine run that produced these numbers and none of which a
   * formatter has.
   */
  usable: ReadonlyMap<string, number>;
  /** Wall-clock milliseconds this candidate took, for the status line. */
  elapsedMs: number;
};

/** One number that moved, already framed as better or worse. */
export type Delta = {
  key: string;
  label: string;
  before: number;
  after: number;
  /** `after - before`. */
  change: number;
  /** `change / before`, or undefined when `before` is 0 and a ratio would be meaningless. */
  fraction?: number;
  /** True when the change is an improvement. Not the same as positive: costs go the other way. */
  good: boolean;
  /** How to render it: a plain number, a percentage, or a fraction of 1 shown as a percent. */
  kind: "number" | "percent" | "ratio";
  /**
   * What this stat's rating converts to in play, before and after — see `Vitals.usable`.
   *
   * Only ever set for the five `IUsableStat` families. `+120 armour` is a number no player can
   * price: the curve is hyperbolic, so the same 120 is worth four points of mitigation on a
   * naked character and a tenth of one on a geared one. Both ends are carried rather than the
   * difference alone, because the row prints the *state* on its hover and the *change* in its
   * cell.
   */
  beforeUsable?: number;
  afterUsable?: number;
};

export type Comparison = {
  /** DPS, effective HP and the rest of the headline figures, biggest mover first. */
  headline: Delta[];
  /**
   * Effective HP per element, kept out of {@link headline} rather than mixed into it.
   *
   * Six more rows is most of a tooltip, and the one a reader wants is already the headline's
   * `ehp` — the weakest element is what actually kills you. The per-element figures still
   * matter on a surface with room for them, because buying fire resistance on a character
   * whose cold is worse moves no headline figure at all, so they are a separate list the
   * Compare tab prints as its own table and the tooltips leave out.
   */
  ehpByElement: Delta[];
  /** Every sheet stat that moved. Empty for a support gem, which never touches the sheet. */
  stats: Delta[];
  /** True when nothing at all moved — a gem that does nothing for this skill. */
  unchanged: boolean;
};

/**
 * The figures a build is read by, in the order they are read in.
 *
 * Exported because more than one surface shows them and they must agree about both the set and
 * the order: the topbar prices a pinned baseline against the same rows the Compare tab lists, and
 * a headline whose rows reshuffled between the two would be two different reports.
 */
export const HEADLINE: {
  key: keyof Vitals & string;
  label: string;
  good: "up" | "down";
  kind: Delta["kind"];
}[] = [
  { key: "totalDps", label: "Total DPS", good: "up", kind: "number" },
  { key: "dps", label: "Skill DPS", good: "up", kind: "number" },
  { key: "fullDps", label: "Full DPS", good: "up", kind: "number" },
  { key: "procDps", label: "Proc DPS", good: "up", kind: "number" },
  // "Ailments" rather than "Ailment DPS": the sidebar's row of that name is the ticking half
  // alone now, and this is the whole clock, Shatter and Shock included.
  { key: "ailmentDps", label: "Ailments", good: "up", kind: "number" },
  { key: "basicDps", label: "Basic attack DPS", good: "up", kind: "number" },
  { key: "summonDps", label: "Summon DPS", good: "up", kind: "number" },
  { key: "critChance", label: "Crit chance", good: "up", kind: "ratio" },
  // The two figures a buff skill is actually read on. Both are about the skill being asked
  // about rather than about the build, which is why they sit below the damage rates rather than
  // among them — but they belong in the headline, because for a buff they are the only rows
  // that will ever move.
  { key: "skillCycleSeconds", label: "Skill cooldown", good: "down", kind: "number" },
  { key: "buffSeconds", label: "Buff duration", good: "up", kind: "number" },
  { key: "pool", label: "Life + magic shield", good: "up", kind: "number" },
  { key: "ehp", label: "Effective HP (weakest)", good: "up", kind: "number" },
];

/**
 * Everything the character sheet alone decides, kept so a candidate that cannot change it
 * need not recompute it.
 *
 * A support gem's stats go onto the *spell* unit, never onto `allStatsWithoutSuppGems`, so
 * linking one normally cannot move the sheet, effective HP or a weapon swing — which has no
 * spell and therefore no gems at all. That is two thirds of what a candidate costs, across
 * ninety of them.
 *
 * **Four gems in this pack are exceptions and the saving is not worth being wrong about them.**
 * Fortify, Power Charge on Crit, Frenzy Charge on Crit and Endurance Charge on Hit each carry a
 * `give_exile_effect` stat, and availability is derived from what the build *can* put up — so
 * socketing one adds an effect whose own stats then land on the character sheet like any other
 * buff's. `supportGemAffectsSheet` is the engine's own answer to which gems those are, asked
 * rather than reimplemented, and `useRanking` takes the full path for each of them.
 *
 * Nothing but a support gem may use this at all. A perk, a jewel, an aura, a different skill on
 * the bar: every one of those changes the sheet.
 */
export type SheetInvariant = {
  run: EngineResult;
  defence: Defence;
  basic: BasicAttack | undefined;
};

/** Captures {@link SheetInvariant} from a document. */
export function sheetInvariantOf(doc: BuildDoc, snapshot: Snapshot): SheetInvariant {
  const run = calculate(doc, snapshot);
  let basic: BasicAttack | undefined;
  try {
    basic = basicAttack(doc, snapshot, { sheets: { character: run, spell: run } });
  } catch {
    basic = undefined;
  }
  return { run, defence: defence(doc, snapshot, { sheet: run }), basic };
}

/**
 * Everything a candidate build is judged on, in one pass.
 *
 * The engine entry points are called in the order their caches want: `calculate` settles the
 * exile-effect fixed point and memoises it against the document, so the ones that follow reuse
 * it rather than each paying for their own.
 */
export type VitalsOptions = {
  /** See {@link SheetInvariant}. Omit it for any change that is not a support gem. */
  invariant?: SheetInvariant;
  /**
   * Which skill `dps` should be about, as an index into `doc.skills`.
   *
   * Omitted, it is the document's own main skill, which is what the Damage tab reports and what
   * a tree node should be priced against — a passive changes every skill, so the one you have
   * chosen to read is the right one.
   *
   * The support gem list must set it, and getting this wrong is silent: a gem linked to a skill
   * that is not the main one moves that skill's damage and not the main one's, so ranking the
   * list on the main skill's DPS scored all ninety gems identically and reported every one of
   * them as having no effect.
   */
  skillIndex?: number;
};

/**
 * Everything that lands on a target while you play this build, composed in one place.
 *
 * Two surfaces reported a figure called "Total DPS" and composed it independently, and they did
 * not agree: the topbar added summons and not the weapon swing, `vitalsOf` added the swing and
 * not summons. So a minion build — nineteen of this pack's skills, whose whole output is
 * `summonDps` — read as a real number in the chrome and as **zero** in every what-if the app
 * made, which meant the tree hover and the gem ranking both reported that nothing you could do
 * to such a build mattered. Nothing in the types could notice; the docstring on the topbar's
 * copy asserted the two were the same composition.
 *
 * One function now, and both call it. The terms come back beside the sum because the callers
 * want them individually: `Vitals` keeps a field per clock, and the topbar's hint names each.
 */
export type DamageRates = {
  /** True when a rotation is ticked, so it stands in for the single skill everywhere below. */
  inRotation: boolean;
  /** The rotation where one is ticked, the main skill's own figure otherwise. */
  primaryDps: number;
  /**
   * Spells the build casts for you.
   *
   * Already inside {@link primaryDps} when `inRotation` — `simulateFullDps` merges the rotation's
   * procs against one shared `proc_cooldown_ticks` ceiling — so {@link total} adds it only when
   * the single skill is standing in.
   */
  procDps: number;
  /** Ailments, on their own clock. Never part of a hit. */
  ailmentDps: number;
  /** The pets. Never in either DPS figure above; see the note in the body. */
  summonDps: number;
  /** The weapon swing, on its own clock too. 0 where nobody computed one. */
  basicDps: number;
  /** The sum. What every surface in this app means by "Total DPS". */
  total: number;
};

export function damageRates(parts: {
  /** The main skill, or whichever skill is being asked about. */
  dps: DpsResult | undefined;
  fullDps: FullDpsResult | undefined;
  /**
   * The weapon swing's figure, where the caller has one.
   *
   * Optional because computing it costs an engine call and not every surface pays for one; a
   * caller that omits it gets a total without the swing rather than a wrong one.
   */
  basicDps?: number;
}): DamageRates {
  const rotationDps = parts.fullDps?.dps ?? 0;
  const inRotation = rotationDps > 0;
  const primaryDps = inRotation ? rotationDps : (parts.dps?.dps ?? 0);
  const procDps = (inRotation ? parts.fullDps?.procDps : parts.dps?.procDps) ?? 0;
  const ailmentDps = (inRotation ? parts.fullDps?.ailmentDps : parts.dps?.ailmentDps) ?? 0;
  // Always the single skill's, even inside a rotation: `FullDpsResult` carries no summon term at
  // all, so there is nothing to double-count and nothing else to read. A rotation of two summon
  // skills therefore reports only the main one's pets — an undercount, which is the direction to
  // be wrong in, and one the engine would have to grow a field to fix.
  const summonDps = parts.dps?.summonDps ?? 0;
  const basicDps = parts.basicDps ?? 0;

  return {
    inRotation,
    primaryDps,
    procDps,
    ailmentDps,
    summonDps,
    basicDps,
    total: primaryDps + (inRotation ? 0 : procDps) + ailmentDps + summonDps + basicDps,
  };
}

export function vitalsOf(doc: BuildDoc, snapshot: Snapshot, options: VitalsOptions = {}): Vitals {
  const started = performance.now();
  const invariant = options.invariant;

  const sheet: EngineResult = invariant?.run ?? calculate(doc, snapshot);

  let dps: DpsResult | undefined;
  let full: FullDpsResult | undefined;
  let swing: BasicAttack | undefined = invariant?.basic;
  // A document mid-edit can name a spell that does not exist. A ranking row that reads "—" beats
  // one that takes the panel down, and the Diagnostics tab already says why.
  try {
    if ((doc.skills ?? []).length > 0) {
      // The invariant's run is handed straight to the figure that would otherwise resolve one,
      // which is where the saving actually lands: the fixed point is 35 ms of a 55 ms candidate.
      const measured = options.skillIndex === undefined ? undefined : (doc.skills ?? [])[options.skillIndex];
      dps = simulateDps(doc, snapshot, {
        ...(invariant === undefined ? {} : { characterRun: invariant.run }),
        ...(measured === undefined ? {} : { skill: measured }),
      });
      // Deliberately *not* given the run: `simulateFullDps` asks about a different skill per
      // entry, and the run's exclusivity tiebreak is the asking skill's own gates. It is free
      // when nothing is ticked into the rotation, which is the common case.
      full = simulateFullDps(doc, snapshot);
    }
    if (swing === undefined) {
      swing = basicAttack(doc, snapshot, { sheets: { character: sheet, spell: sheet } });
    }
  } catch {
    // Left undefined; every figure below reads 0.
  }

  const def: Defence = invariant?.defence ?? defence(doc, snapshot, { sheet });

  return assembleVitals({
    stats: sheet.stats,
    dps,
    fullDps: full,
    basicDps: swing?.dps ?? 0,
    defence: def,
    elapsedMs: performance.now() - started,
  });
}

/**
 * The only place a {@link Vitals} is built.
 *
 * Two callers reach it: {@link vitalsOf}, which runs the engine for a document nobody has
 * committed to, and {@link vitalsFromDerived}, which reads the run the app already made for the
 * document on screen. Keeping the assembly in one function is what makes those two
 * interchangeable — a comparison whose two sides were assembled by different code would report
 * differences that are only differences in how they were measured.
 */
function assembleVitals(parts: {
  /** The character sheet. */
  stats: ReadonlyMap<string, EngineStat>;
  dps: DpsResult | undefined;
  fullDps: FullDpsResult | undefined;
  basicDps: number;
  defence: Defence;
  elapsedMs: number;
}): Vitals {
  const { dps, fullDps, defence: def } = parts;
  const rates = damageRates({ dps, fullDps, basicDps: parts.basicDps });

  const stats = new Map<string, number>();
  const usable = new Map<string, number>();
  for (const [id, stat] of parts.stats) {
    // `dmgMulti` is where every `MULTIPLICATIVE_DAMAGE` stat keeps its whole contribution while
    // its value stays at zero, so a diff that only read `value` would miss the entire family —
    // which is a quarter of a fire skill's damage on the reference build.
    const carried = stat.value !== 0 ? stat.value : (stat.dmgMulti - 1) * 100;
    if (carried !== 0) stats.set(id, carried);
    // Kept even at zero, unlike the value above: a candidate that takes armour from 0 to 400 has
    // no *before* entry in `stats` and the diff still has to print where the mitigation started.
    if (stat.usableValue !== undefined) usable.set(id, stat.usableValue);
  }

  return {
    // `dps` is deliberately the asked-about skill's own figure and not `rates.primaryDps`: the
    // Skill DPS row means that skill, and the rotation has its own row beneath it.
    dps: dps?.dps ?? 0,
    critDps: dps?.critDps ?? 0,
    fullDps: fullDps === undefined ? 0 : fullDps.dps + fullDps.ailmentDps,
    procDps: rates.procDps,
    ailmentDps: rates.ailmentDps,
    basicDps: rates.basicDps,
    summonDps: rates.summonDps,
    totalDps: rates.total,
    critChance: dps?.hit.critChance ?? 0,
    skillCycleSeconds: dps?.rate.cycleSeconds ?? 0,
    // `infinite` is the toggle sentinel and `Infinity` would make every delta `NaN`. See the
    // field's own note for why both it and "no buff at all" report 0.
    buffSeconds:
      dps?.buff === undefined || !Number.isFinite(dps.buff.durationSeconds)
        ? 0
        : dps.buff.durationSeconds,
    pool: def.pools.health + def.pools.magicShield,
    ehp: def.weakest.effectiveHealth,
    weakestElement: def.weakest.element,
    ehpByElement: def.byElement.map((e) => ({
      element: e.element,
      effectiveHealth: e.effectiveHealth,
    })),
    stats,
    usable,
    elapsedMs: parts.elapsedMs,
  };
}

/**
 * The open document's vitals, out of the engine run the app has already made.
 *
 * `useDerived` computes the sheet, the hit, the rotation, the swing and the defence figure for
 * every document the moment it changes, and every one of those is a term of a `Vitals`. Calling
 * {@link vitalsOf} on the same document would run all of it a second time — 7 to 12 ms on a
 * level-100 character, on the render path, on every edit, for an answer already in hand.
 *
 * `breakdown: true` is the only difference between the two runs, and it changes no number: it is
 * an array push per layer write, which is why the Damage tab can have it on always.
 */
export function vitalsFromDerived(derived: DerivedBuild): Vitals {
  return assembleVitals({
    stats: derived.stats,
    dps: derived.dps,
    fullDps: derived.fullDps,
    basicDps: derived.basic?.dps ?? 0,
    defence: derived.defence,
    elapsedMs: derived.elapsedMs,
  });
}

/**
 * The difference between two candidates, ready to render.
 *
 * `minusIsGood` is read off `mmorpg_stat` rather than guessed: 19 of this pack's stats are
 * better when they go down — cooldowns, costs, the two `*_received` families — and a panel that
 * painted every increase green would call a mana-cost increase an improvement.
 */
export function compare(
  before: Vitals,
  after: Vitals,
  snapshot: Snapshot,
  options: { statEpsilon?: number } = {},
): Comparison {
  const epsilon = options.statEpsilon ?? 1e-6;

  const headline: Delta[] = [];
  for (const row of HEADLINE) {
    const a = before[row.key] as number;
    const b = after[row.key] as number;
    if (Math.abs(b - a) <= epsilon) continue;
    // `row.good` is which *direction* is an improvement for this figure, not whether this
    // particular change was one. Passing it through as the verdict painted every headline row
    // green whichever way it went, so a passive that cost DPS and a passive that bought it were
    // the same colour — which is the one thing the block exists to tell apart.
    headline.push(delta(row.key, row.label, a, b, row.good === "up" ? b > a : b < a, row.kind));
  }

  // Effective HP per element as well as the weakest, because the weakest one alone hides the
  // commonest defensive change there is: taking fire resistance on a character whose cold is
  // worse moves no headline figure at all, and reading "Effective HP +0" after buying a resist
  // is worse than reading nothing. Its own list rather than six more headline rows — see
  // `Comparison.ehpByElement`.
  const ehpByElement: Delta[] = [];
  const beforeByElement = new Map(before.ehpByElement.map((e) => [e.element, e.effectiveHealth]));
  for (const { element, effectiveHealth } of after.ehpByElement) {
    const a = beforeByElement.get(element) ?? 0;
    if (Math.abs(effectiveHealth - a) <= epsilon) continue;
    ehpByElement.push(
      delta(`ehp:${element}`, `EHP vs ${element}`, a, effectiveHealth, effectiveHealth > a, "number"),
    );
  }

  const stats: Delta[] = [];
  for (const id of new Set([...before.stats.keys(), ...after.stats.keys()])) {
    const a = before.stats.get(id) ?? 0;
    const b = after.stats.get(id) ?? 0;
    if (Math.abs(b - a) <= epsilon) continue;
    const display: StatDisplay = statDisplay(snapshot, id);
    const improved = display.minusIsGood ? b < a : b > a;
    const row = delta(id, statLabel(snapshot, display, b), a, b, improved, display.isPerc ? "percent" : "number");
    // Armour and dodge are the two rows a defensive comparison is actually read on, and the
    // rating alone does not say what it bought. `before` may have no entry where the stat was
    // absent altogether, which is a mitigation of 0 rather than an unknown.
    const beforeUsable = before.usable.get(id);
    const afterUsable = after.usable.get(id);
    if (beforeUsable !== undefined || afterUsable !== undefined) {
      row.beforeUsable = beforeUsable ?? 0;
      row.afterUsable = afterUsable ?? 0;
    }
    stats.push(row);
  }

  // Both lists lead with what moved most.
  //
  // The headline used to keep its declared order, on the reasoning that a tooltip whose rows
  // reshuffle between one node and the next cannot be compared against the last one. In
  // practice the fixed order buried the answer: a node that moves Total DPS by a third and
  // crit chance by a hundredth listed them in the same places as a node that does the reverse,
  // and the reader had to scan ten rows to find which. Ranked, the top row *is* the answer.
  // `ComparePanel` prints the full set in its declared order and is unaffected, because it
  // walks `HEADLINE` itself rather than this list.
  headline.sort(byMagnitude);
  stats.sort(byMagnitude);

  return {
    headline,
    ehpByElement,
    stats,
    unchanged: headline.length === 0 && ehpByElement.length === 0 && stats.length === 0,
  };
}

/**
 * What to call a stat on a diff row.
 *
 * 57 of this pack's stats are named with a **whole templated sentence** rather than a label —
 * `[VAL1]% Chance to Cast Fan of Knives on Hit`, `Gain [VAL1]% of your ☆ Strength as ❤ Health` —
 * and `statDisplay.name` hands back the template unfilled. Printed straight into a table that put
 * the literal placeholder on screen, which reads as the variable name having leaked out of the
 * data. It had.
 *
 * `[VAL1]` is filled with the value the stat lands on, which is what the sentence is about: the
 * row then reads "27% Chance to Cast Fan of Knives on Hit" and the columns beside it say how far
 * that moved. It is the same substitution the stat sheet makes (`StatList`), so a stat named one
 * way there is named the same way here.
 */
function statLabel(snapshot: Snapshot, display: StatDisplay, after: number): string {
  if (!display.templated) return display.name;
  const raw = statNameRaw(snapshot, display.id);
  return raw === undefined ? display.name : stripFormatting(fillTemplate(raw, [after]));
}

/**
 * Orders by how much a number moved *relative to itself*, not by how big the move was.
 *
 * Sorting on the raw change puts DPS above everything for the rest of time, because DPS is
 * measured in hundreds of thousands and crit chance in hundredths. A build is read by which of
 * its numbers moved the most, which is the fraction.
 */
function byMagnitude(a: Delta, b: Delta): number {
  const scale = (d: Delta): number =>
    d.fraction === undefined ? Number.POSITIVE_INFINITY : Math.abs(d.fraction);
  return scale(b) - scale(a);
}

function delta(
  key: string,
  label: string,
  before: number,
  after: number,
  good: boolean,
  kind: Delta["kind"],
): Delta {
  const change = after - before;
  return {
    key,
    label,
    before,
    after,
    change,
    // A change from zero has no percentage: "+∞%" is not information, and the absolute number
    // beside it already is.
    ...(before === 0 ? {} : { fraction: change / Math.abs(before) }),
    good,
    kind,
  };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * The current build's vitals, memoised on document identity.
 *
 * Every mutator in the store produces a new document and nothing mutates one in place, so
 * reference equality is a sound cache key — the same rule `useDerived` relies on.
 *
 * With no `skillIndex` this is free: the figures come out of the run `useDerived` already made
 * for this document. That is the common case and the one that was costing a second full engine
 * pass on every edit — the tree hover, the gem ranking and the comparison surfaces all take a
 * base from here. A stated `skillIndex` asks about a skill the app has not computed, so that one
 * still runs.
 */
export function useVitals(skillIndex?: number): Vitals {
  const doc = useBuild((state) => state.doc);
  const derived = useDerived();
  const { snapshot } = useWorld();
  return useMemo(
    () =>
      skillIndex === undefined
        ? vitalsFromDerived(derived)
        : vitalsOf(doc, snapshot, { skillIndex }),
    [derived, doc, snapshot, skillIndex],
  );
}

/** A pinned baseline, priced against the build on screen. */
export type BaselineComparison = {
  /** What is pinned, for naming it on screen. */
  baseline: Baseline;
  /** The pinned build's figures. */
  before: Vitals;
  /** The open build's figures. */
  after: Vitals;
  comparison: Comparison;
};

/**
 * The open build measured against whatever is pinned, or null when nothing is.
 *
 * Two memos rather than one, because the two sides go stale at completely different rates. The
 * baseline is a document that by construction never changes — see `Baseline` — so its vitals are
 * computed once per pin and reused across every edit you then make. Only `compare` runs per edit,
 * and that is a walk over two stat maps.
 *
 * It is the same `compare` the tree tooltip and the gem ranking use, so a node that the tree
 * prices at `+4,200 Total DPS` moves the baseline delta by `+4,200`. There is no second opinion
 * available for it to disagree with.
 */
export function useBaselineComparison(): BaselineComparison | null {
  const baseline = useBuild((state) => state.baseline);
  const { snapshot } = useWorld();
  const after = useVitals();

  const before = useMemo(
    () => (baseline === null ? null : vitalsOf(baseline.doc, snapshot)),
    [baseline, snapshot],
  );

  return useMemo(() => {
    if (baseline === null || before === null) return null;
    return { baseline, before, after, comparison: compare(before, after, snapshot) };
  }, [baseline, before, after, snapshot]);
}

/** One priced candidate: what it would be, and how that differs from what you have. */
export type WhatIf = { vitals: Vitals; comparison: Comparison };

/**
 * Prices a click, a beat after the cursor settles — and, where they differ, the node on its own.
 *
 * The tree's hover is the case this exists for: moving across the tree crosses dozens of nodes
 * on the way to the one you meant, and pricing every one of them would spend ten milliseconds
 * each on answers nobody reads. So the documents are held for {@link delayMs} and only the node
 * the cursor actually stopped on is computed.
 *
 * ## Why two
 *
 * A click is rarely one node. Taking a distant talent buys the cheapest route to it, and
 * refunding a node gives back everything that was hanging off it — on the reference build,
 * refunding the ascendancy's entry node costs **38%** of the build's damage while the node's own
 * stats are worth **0.5%**. Those are both worth knowing and they are not the same question:
 * `click` is what the button does, `alone` is what this node is actually contributing.
 *
 * `alone` is deliberately *not* a legal click — it is the node with its dependents left where
 * they are, which the tree would never let you do. The tooltip labels it as such.
 *
 * Both are priced inside one timer against one baseline, so a hover costs one debounce rather
 * than two and the two figures can never be computed against different builds.
 *
 * `undefined` while the timer is running, which is what lets a tooltip show the node's own
 * facts immediately and fill the numbers in underneath.
 */
export function useWhatIf(
  candidate: BuildDoc | undefined,
  alone?: BuildDoc | undefined,
  delayMs = 90,
): { click: WhatIf; alone?: WhatIf } | undefined {
  const { snapshot } = useWorld();
  const base = useVitals();
  const [result, setResult] = useState<{ click: WhatIf; alone?: WhatIf } | undefined>();

  useEffect(() => {
    if (candidate === undefined) {
      setResult(undefined);
      return;
    }
    setResult(undefined);
    const timer = setTimeout(() => {
      try {
        const priced = (doc: BuildDoc): WhatIf => {
          const vitals = vitalsOf(doc, snapshot);
          return { vitals, comparison: compare(base, vitals, snapshot) };
        };
        const click = priced(candidate);
        setResult(alone === undefined ? { click } : { click, alone: priced(alone) });
      } catch {
        // A document the engine cannot evaluate shows the node's facts and no numbers, which is
        // what the tooltip renders for `undefined` anyway.
        setResult(undefined);
      }
    }, delayMs);
    return () => clearTimeout(timer);
  }, [candidate, alone, snapshot, base, delayMs]);

  return result;
}

/**
 * Several candidates, priced together against the build on screen.
 *
 * {@link useWhatIf} answers one question about one document — the tree hover, where the cursor is
 * on one node. The gear panel asks the same question two or three times at once: a ring fits
 * either finger, so "what would this ring do" has an answer per finger and both are true. Running
 * two `useWhatIf`s would mean two debounce timers and two baselines, and a hook per position is
 * not a shape React allows anyway.
 *
 * One timer, one baseline, every candidate priced in the same tick. The delay is what it is for
 * in the tree: selecting an item in a list is a lot of intermediate selections on the way to the
 * one you meant, and each of those is a full engine pass per position.
 *
 * `candidates` must be **memoised by the caller** — its identity is the effect's dependency, so
 * an array rebuilt every render prices the same documents forever. Same contract `useWhatIf` has.
 */
export function useWhatIfEach(
  candidates: readonly { key: string; doc: BuildDoc }[] | undefined,
  delayMs = 90,
): ReadonlyMap<string, WhatIf> | undefined {
  const { snapshot } = useWorld();
  const base = useVitals();
  const [result, setResult] = useState<ReadonlyMap<string, WhatIf> | undefined>();

  useEffect(() => {
    if (candidates === undefined || candidates.length === 0) {
      setResult(undefined);
      return;
    }
    setResult(undefined);
    const timer = setTimeout(() => {
      const priced = new Map<string, WhatIf>();
      for (const { key, doc } of candidates) {
        try {
          const vitals = vitalsOf(doc, snapshot);
          priced.set(key, { vitals, comparison: compare(base, vitals, snapshot) });
        } catch {
          // One candidate the engine cannot evaluate must not take the others with it: the row
          // simply shows the item's own facts, which is what an absent entry renders as.
        }
      }
      setResult(priced);
    }, delayMs);
    return () => clearTimeout(timer);
  }, [candidates, snapshot, base, delayMs]);

  return result;
}

/** One row of a ranked list: a candidate, priced. */
export type Ranked<T> = {
  candidate: T;
  id: string;
  vitals: Vitals;
  comparison: Comparison;
};

export type Ranking<T> = {
  /** Rows resolved so far, best first. Grows as the work completes. */
  rows: Ranked<T>[];
  /**
   * What every row was measured against.
   *
   * Handed back rather than recomputed by the caller, because with a `skillIndex` it is a full
   * engine pass — and a list that labelled itself from a second one could label itself with a
   * different answer than the one it sorted by.
   */
  base: Vitals;
  /** How many candidates have been priced, out of how many there are. */
  done: number;
  total: number;
  /** True while work remains. The list is already usable. */
  pending: boolean;
};

/**
 * Prices a list of candidates without blocking the interface.
 *
 * Ninety support gems at 6 ms each is over half a second, which is an eternity to hold a click.
 * So the work is cut into slices and spread across animation frames: each slice does as many
 * candidates as fits in {@link SLICE_MS}, publishes what it has, and yields. The list sorts and
 * re-renders as it fills, which is also why the sort is by a *fraction* — a partial list ordered
 * by relative gain is meaningful, where one ordered by absolute DPS looks arbitrary until the
 * biggest number arrives.
 *
 * `enabled` is what stops a closed picker from doing any of this. `candidates` and `apply` must
 * be stable across renders — wrap them in `useMemo` and `useCallback` — because a new identity
 * restarts the sweep from the beginning.
 */
export function useRanking<T>({
  candidates,
  apply,
  keyOf,
  enabled = true,
  rank,
  reuseSheetFor,
  skillIndex,
}: {
  candidates: readonly T[];
  /** The document this candidate would produce. Called once per candidate. */
  apply: (candidate: T) => BuildDoc;
  keyOf: (candidate: T) => string;
  enabled?: boolean;
  /** Which figure orders the list. Defaults to total DPS. */
  rank?: (vitals: Vitals, base: Vitals) => number;
  /**
   * Which candidates cannot change the character sheet, so may reuse the base's.
   *
   * See {@link SheetInvariant} — only a support gem qualifies, and only most of them. Omitted,
   * every candidate takes the full path, which is always correct and roughly three times slower.
   */
  reuseSheetFor?: (candidate: T) => boolean;
  /**
   * Which skill every row's `dps` is about — see {@link VitalsOptions.skillIndex}.
   *
   * It applies to the baseline as well as to the candidates, which is the point: a comparison
   * between two different skills is not a comparison.
   */
  skillIndex?: number;
}): Ranking<T> {
  const doc = useBuild((state) => state.doc);
  const { snapshot } = useWorld();
  /*
   * The baseline is only computed while the list is open, and `enabled` is what says so.
   *
   * `useVitals(skillIndex)` with a stated index is a **full engine pass** — sheet, hit,
   * rotation, swing and defence, 7 to 12 ms on a level-100 character — because it is asking
   * about a skill the app has not computed. It used to be called unconditionally, which meant
   * every closed `SupportGemPicker` on the Skills tab paid for one on every render. A Skill with
   * five gems has five of those pickers mounted, so opening the tab cost five engine passes
   * before anything was clicked, and every keystroke in the level box cost five more. That was
   * the tab's whole stutter.
   *
   * Closed, the argument is dropped and `useVitals` returns the run `useDerived` already made
   * for the open document, which is free. Opening re-runs this hook with the index, which is one
   * pass, once, at the moment the answer is wanted.
   */
  const base = useVitals(enabled ? skillIndex : undefined);
  const invariant = useMemo(
    () => (reuseSheetFor !== undefined && enabled ? sheetInvariantOf(doc, snapshot) : undefined),
    [reuseSheetFor, enabled, doc, snapshot],
  );

  const [rows, setRows] = useState<Ranked<T>[]>([]);
  const [done, setDone] = useState(0);

  // Read through a ref so a changing sort function does not restart the sweep.
  const rankRef = useRef(rank);
  rankRef.current = rank;

  useEffect(() => {
    if (!enabled || candidates.length === 0) {
      setRows([]);
      setDone(0);
      return;
    }

    let cancelled = false;
    let index = 0;
    const collected: Ranked<T>[] = [];
    let frame = 0;

    const step = (): void => {
      if (cancelled) return;
      const until = performance.now() + SLICE_MS;
      // At least one per frame, so a snapshot slow enough to blow the budget on a single
      // candidate still makes progress instead of spinning.
      do {
        const candidate = candidates[index]!;
        try {
          const reuse = reuseSheetFor?.(candidate) === true ? invariant : undefined;
          const vitals = vitalsOf(apply(candidate), snapshot, {
            ...(reuse === undefined ? {} : { invariant: reuse }),
            ...(skillIndex === undefined ? {} : { skillIndex }),
          });
          collected.push({
            candidate,
            id: keyOf(candidate),
            vitals,
            comparison: compare(base, vitals, snapshot),
          });
        } catch {
          // A candidate the engine cannot evaluate is left out rather than shown as a zero,
          // which would rank it below every gem that merely does nothing.
        }
        index++;
      } while (index < candidates.length && performance.now() < until);

      const ordered = [...collected].sort((a, b) => score(b) - score(a));
      setRows(ordered);
      setDone(index);

      if (index < candidates.length) frame = requestAnimationFrame(step);
    };

    const score = (row: Ranked<T>): number =>
      rankRef.current ? rankRef.current(row.vitals, base) : row.vitals.totalDps;

    frame = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
    // `doc` is in the list because `apply` closes over it: a candidate priced against the
    // previous document is stale the moment anything else changes.
  }, [candidates, apply, keyOf, enabled, snapshot, base, doc, invariant, reuseSheetFor, skillIndex]);

  return { rows, base, done, total: candidates.length, pending: done < candidates.length };
}

/**
 * How long one slice of ranking work may take.
 *
 * Eight milliseconds leaves half a 60 Hz frame for React to render what the last slice produced.
 * Longer slices finish the sweep sooner and make the list stutter while it does.
 */
const SLICE_MS = 8;
