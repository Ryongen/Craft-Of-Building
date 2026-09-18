/**
 * The answer, where you can always see it.
 *
 * Every number this app produces lived inside a tab. You could be on the Gear tab swapping a
 * ring and have no idea whether it helped — the figure that would tell you was two clicks away,
 * and by the time you got there you had lost the number you were comparing against.
 *
 * So the four figures that answer "is this build better" sit in the chrome: what you deal, what
 * it takes to kill you, and the pool behind that. They are read straight off `useDerived`, which
 * every panel already consumes, so this costs one more render of four spans rather than another
 * pass of the engine.
 *
 * ## Which DPS
 *
 * `damageRates` — the same function `state/compare.ts` prices every what-if with, so the figure
 * in the chrome and the delta beside it cannot be two different numbers. This docstring used to
 * *claim* that while the two compositions actually differed by two terms; the note on
 * `damageRates` records what that cost.
 *
 * It is deliberately not `dps`: a gem that adds nothing to the hit but doubles a proc rate is
 * invisible in the skill's own figure and real in this one.
 *
 * ## The deltas
 *
 * With a baseline pinned on the Compare tab, each figure carries how far it has moved from it —
 * which is what makes a comparison usable while you work: the point of pinning is to re-gear a
 * character over twenty minutes, and a number you have to change tab to read is a number you stop
 * reading. The rows come from the same `compare` the Compare tab lists, keyed by `HEADLINE`, so
 * the percentage here is the percentage there.
 */

import type { ReactNode } from "react";

import type { SheetFocus } from "../panels/stats/SheetDetail.js";
import { damageRates, useBaselineComparison, type Delta } from "../state/compare.js";
import { useDerived } from "../state/derived.js";
import { Figure } from "./Figure.js";
import { compact, percent, signGlyph } from "./format.js";

export function Headline({ onFocus }: { onFocus?: (focus: SheetFocus) => void }): ReactNode {
  const derived = useDerived();
  const { dps, fullDps, basic, defence } = derived;
  const against = useBaselineComparison();

  const rates = damageRates({ dps, fullDps, basicDps: basic?.dps ?? 0 });
  const { inRotation, primaryDps, procDps, ailmentDps, summonDps, basicDps } = rates;
  const totalDps = rates.total;

  const weakest = defence.weakest;
  const pool = defence.pools.health + defence.pools.magicShield;

  // `compare` omits a figure that did not move, so a missing key means "unchanged" and renders
  // nothing at all rather than a `+0` beside every number you have not touched yet.
  const moved = new Map((against?.comparison.headline ?? []).map((d) => [d.key, d]));
  const deltaFor = (key: string): ReactNode => {
    const delta = moved.get(key);
    if (against === null || delta === undefined) return undefined;
    return <DeltaTag delta={delta} baseline={against.baseline.name} />;
  };

  return (
    <div className="row gap-8" style={{ marginLeft: 4 }}>
      <Figure
        size="sm"
        label="TOTAL DPS"
        value={compact(totalDps)}
        delta={deltaFor("totalDps")}
        {...(onFocus === undefined
          ? {}
          : { onClick: () => onFocus({ kind: "figure", id: "total-dps" }) })}
        hint={
          `Everything that lands on the target while you play this build: ` +
          `${inRotation ? "the rotation" : "your main skill"} at ${compact(primaryDps)}` +
          (procDps > 0 && !inRotation ? `, procs ${compact(procDps)}` : "") +
          (ailmentDps > 0 ? `, ailments ${compact(ailmentDps)}` : "") +
          (summonDps > 0 ? `, summons ${compact(summonDps)}` : "") +
          (basicDps > 0 ? `, weapon swing ${compact(basicDps)}` : "") +
          `. Open the Damage tab for the breakdown.`
        }
      />
      <Figure
        size="sm"
        label="EHP"
        value={compact(weakest.effectiveHealth)}
        delta={deltaFor("ehp")}
        {...(onFocus === undefined
          ? {}
          : { onClick: () => onFocus({ kind: "figure", id: "ehp" }) })}
        hint={
          `Effective HP against your weakest element (${weakest.element}): the pool divided by ` +
          `the share of a hit that gets through. It is the element that actually kills you.`
        }
      />
      <Figure
        size="sm"
        label="POOL"
        value={compact(pool)}
        delta={deltaFor("pool")}
        {...(onFocus === undefined
          ? {}
          : { onClick: () => onFocus({ kind: "stat", statId: "health" }) })}
        hint={
          `Life ${compact(defence.pools.health)}` +
          (defence.pools.magicShield > 0
            ? ` plus ${compact(defence.pools.magicShield)} magic shield, which a hit spends first`
            : "") +
          `. Before any mitigation.`
        }
      />
    </div>
  );
}

/**
 * One figure's move from the baseline, in the chrome's very small space.
 *
 * A percentage, not the absolute change: at this width `+12%` fits and `+143,204` does not, and
 * the percentage is the figure you compare between two different builds anyway. The absolute
 * change is on the hover, and the Compare tab has both in full.
 *
 * Where the baseline read zero there is no percentage to give — `compare` leaves `fraction` off
 * rather than printing `+∞%` — so those fall back to the signed absolute.
 */
function DeltaTag({ delta, baseline }: { delta: Delta; baseline: string }): ReactNode {
  return (
    <span
      className={delta.good ? "up" : "down"}
      title={`${delta.label}: ${compact(delta.before)} → ${compact(delta.after)} against “${baseline}”`}
    >
      {delta.fraction === undefined
        ? signGlyph(delta.change) + compact(Math.abs(delta.change))
        : percent(delta.fraction)}
    </span>
  );
}
