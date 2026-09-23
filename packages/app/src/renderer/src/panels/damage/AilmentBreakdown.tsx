/**
 * The ailment's own damage event, on the same screen as the hit that inflicted it.
 *
 * An ailment is a second `DamageEvent` and the game prints it as its own block in the damage log
 * — `Damage Over Time / Ailment: Bleed`, with its own base, its own layers and its own MOREs.
 * That is the whole reason it deserves a breakdown rather than a figure: its `additive_damage` is
 * a *different* number from the hit's, because the event is `dot`/`int` rather than `hit` and the
 * weapon's style, and reading the two side by side is how you see which of your stats crossed
 * over and which did not.
 *
 * ## Buttons rather than cards
 *
 * A build that bleeds and poisons inflicts two of these, and a build stacking Shatter inflicts a
 * third that is not a rate at all. Stacked as cards they were three more things to scroll past to
 * reach the hit trace. They are a row of buttons instead, in the same style as Hit and Crit
 * beside them, because they are the same kind of choice: which of several readings of one cast
 * you are looking at.
 *
 * ## Two shapes, not one
 *
 * A DoT stacks once per landing hit, so its headline is one stack's rate and its life is
 * the note under it. Freeze and Electrify deal nothing when they land: they fill a pool that a
 * later hit carrying Shatter or Shock releases in one spike, so their headline is the pool and
 * the note is what tips it. Printing "0/s" for the second kind was technically true and told a
 * cold build its damage did nothing.
 *
 * ## Why this is several exports rather than one component
 *
 * The buttons, the summary and the trace are three cells of the breakdown's grid, so each lines
 * up with its opposite number in the hit column — the traces especially, which are the two things
 * a reader is comparing and which started a hundred and twenty pixels apart when each column
 * stacked its own header. The selection therefore lives in the panel rather than in here.
 */

import { type AilmentResult, type AilmentStacks, type DamageResult } from "@cte2/engine";
import { type ReactNode } from "react";

import { num, smart } from "../../ui/fields.js";

import { COLOURS } from "./colours.js";
import { TraceBlock } from "./Trace.js";

/** Only the ones this cast can actually inflict. An ailment at 0% is not a reading of anything. */
export function inflicted(ailments: readonly AilmentResult[]): AilmentResult[] {
  return ailments.filter((a) => a.chance > 0 && (a.totalDamage > 0 || a.accumulated > 0));
}

/**
 * The one being shown, by id rather than by index.
 *
 * The list is rebuilt from the hit on every edit, and a build that stops freezing renumbers it —
 * an index would quietly start describing a different ailment. An id that is no longer inflicted
 * falls back to the first, which is the same rule the act picker uses.
 */
export function shownAilment(
  ailments: readonly AilmentResult[],
  shownId: string | null,
): AilmentResult | undefined {
  const live = inflicted(ailments);
  return live.find((a) => a.ailment === shownId) ?? live[0];
}

export function AilmentButtons({
  ailments,
  shown,
  onSelect,
}: {
  ailments: readonly AilmentResult[];
  shown: AilmentResult | undefined;
  onSelect: (id: string) => void;
}): ReactNode {
  const live = inflicted(ailments);
  // One ailment needs no chooser, but the band still has to be occupied or the summary beside it
  // rides up and the two columns stop lining up, which is the whole point of the grid.
  if (live.length <= 1) return <div className="bd-spacer" />;

  return (
    <div className="row wrap">
      {live.map((ailment) => (
        <button
          key={ailment.ailment}
          className={ailment.ailment === shown?.ailment ? "primary" : ""}
          onClick={() => onSelect(ailment.ailment)}
          style={
            ailment.ailment === shown?.ailment
              ? undefined
              : { color: COLOURS[ailment.element] ?? "var(--text)" }
          }
        >
          {AILMENT_NAME[ailment.ailment] ?? ailment.ailment}
        </button>
      ))}
    </div>
  );
}

/**
 * What this ailment is worth, in the shape the hit's total takes beside it: a headline, a line
 * saying what qualifies it, and the terms underneath.
 */
export function AilmentSummary({
  ailment,
  elsewhere,
  stacks,
}: {
  ailment: AilmentResult | undefined;
  /**
   * The rotation's stacks of every DoT, from the average hit. The headline above is one
   * application; these rows are what the rate card counts, because bleeds, burns and poisons do
   * not refresh — each hit adds another that runs its own full duration.
   */
  stacks?: readonly AilmentStacks[] | undefined;
  /**
   * Other acts of this cast that do inflict something, when the selected one does not.
   *
   * A cast can be several acts with different elements — `tailwind_sweep` is a physical one and a
   * cold one — and only the cold one freezes. "This act inflicts no ailment" beside a total
   * upstairs that plainly comes with a freeze reads as a contradiction rather than as the per-act
   * answer it is, so the empty state names the act the reader wants instead.
   */
  elsewhere?: readonly string[] | undefined;
}): ReactNode {
  if (ailment === undefined) {
    return (
      <div className="faint text-sm prose">
        {elsewhere !== undefined && elsewhere.length > 0 ? (
          <>
            This act inflicts no ailment, but another act of the same cast does. Pick{" "}
            {elsewhere.map((name, i) => (
              <span key={name}>
                {i > 0 && " or "}
                <strong>{name}</strong>
              </span>
            ))}{" "}
            above to see it.
          </>
        ) : (
          <>
            This hit inflicts no ailment. Bleed, Ignite and Poison need a{" "}
            <span className="mono">_chance</span> stat on the sheet, and Shatter and Shock need one
            to fill the pool and a second to release it.
          </>
        )}
      </div>
    );
  }

  const colour = COLOURS[ailment.element] ?? "var(--text)";
  const dot = ailment.damagePerSecond > 0;
  const stack = dot ? stacks?.find((s) => s.ailment === ailment.ailment) : undefined;

  return (
    <>
      <div className="dmg-total" style={{ color: colour }}>
        {dot ? `${smart(ailment.damagePerSecond)}/s` : smart(ailment.accumulated)}
      </div>
      <div className="faint text-sm">
        {dot ? (
          <>
            each, for {num(ailment.durationSeconds, 1)}s — {smart(ailment.totalDamage)} over its life
          </>
        ) : ailment.procChance > 0 ? (
          // The pool is only worth something if something tips it. Naming the proc and its chance
          // on the same line is what turns "accumulates 11,305" from a number with no consequence
          // into the Shatter it is waiting for.
          <>
            released by {PROC_NAME[ailment.ailment] ?? "a proc"} at{" "}
            {num(ailment.procChance * 100, 1)}% — the pool leaks{" "}
            {num(ailment.poolDecayPerSecond * 100, 0)}%/s while it waits
          </>
        ) : (
          <>
            <strong>nothing releases it</strong>: without {PROC_NAME[ailment.ailment] ?? "a proc"}{" "}
            chance the pool only leaks away at {num(ailment.poolDecayPerSecond * 100, 0)}%/s
          </>
        )}
      </div>

      {/*
        The terms, laid out as the hit's element split is laid out, so the two columns read as one
        table rather than as a figure row facing a list.
      */}
      <div className="mt-3 mb-4">
        <div
          className="ele-row"
          title={`${ailment.ailment}_chance — the odds this hit inflicts it at all`}
        >
          <span className="faint">Chance</span>
          <span className="num">{num(ailment.chance * 100, 1)}%</span>
        </div>
        <div
          className="ele-row"
          title="The pre-multiplier number plus flat damage, scaled by however much of the hit converted away. The ailment's own event starts here."
        >
          <span className="faint">Hit handed it</span>
          <span className="num">{smart(ailment.hitBase)}</span>
        </div>
        <div
          className="ele-row"
          title="What the ailment's own DamageEvent turned that into — the gap between the two is what your ailment stats are worth"
        >
          <span className="faint">Its event made</span>
          <span className="num">{smart(ailment.eventDamage)}</span>
        </div>
        {stack !== undefined && (
          <>
            <div
              className="ele-row"
              title={`Landing hits per second times the chance each one inflicts it — ${num(stack.applicationsPerSecond, 1)} a second, each lasting ${num(stack.durationSeconds, 1)}s. They stack without limit.`}
            >
              <span className="faint">Stacks up at once</span>
              <span className="num">{num(stack.stacks, 1)}</span>
            </div>
            <div
              className="ele-row"
              title={`Every stack ticking together, from the average hit. Takes ${num(stack.durationSeconds, 1)}s of casting to build up.`}
            >
              <span className="faint">At full stacks</span>
              <span className="num" style={{ color: colour }}>
                {smart(stack.dps)}/s
              </span>
            </div>
          </>
        )}
      </div>
    </>
  );
}

export function AilmentTrace({
  ailment,
  target,
}: {
  ailment: AilmentResult | undefined;
  target?: DamageResult["target"] | undefined;
}): ReactNode {
  if (ailment === undefined) return null;
  if (ailment.trace === undefined) {
    return <div className="notice">No trace was recorded for this ailment&apos;s event.</div>;
  }
  return <TraceBlock trace={ailment.trace} target={target} />;
}

/** The word on the player's own gear, rather than the id the Java uses. */
const AILMENT_NAME: Record<string, string> = {
  burn: "Ignite",
  poison: "Poison",
  bleed: "Bleed",
  freeze: "Freeze",
  electrify: "Electrify",
};

/**
 * What the game calls the proc that releases each pooled ailment.
 *
 * `AilmentProcStat.locNameForLangFile` is `ailment.procNameWord()`, and the two words are the
 * ones on the player's own gear — nobody stacks "freeze proc chance", they stack Shatter.
 */
const PROC_NAME: Record<string, string> = {
  freeze: "Shatter",
  electrify: "Shock",
};
