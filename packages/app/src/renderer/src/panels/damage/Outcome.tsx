/**
 * What one branch of the hit came to, above the rows that got it there.
 *
 * Three of these used to sit across the top of the tab — Hit, Crit and Average, side by side,
 * each repeating the element split and the ailment block underneath it. That arrangement pushed
 * the breakdown, which is what the tab is for, below the fold; and two thirds of it was answering
 * a question the reader had not asked yet, because only one branch can be traced at a time.
 *
 * So the branch is a choice now and this is the head of it: the total, what it is made of by
 * element, and nothing else. The ailments moved to their own column, where they get the whole of
 * their own event instead of two lines.
 */

import { type HitOutcome } from "@cte2/engine";
import { ELEMENTS, type ElementName } from "@cte2/schema";
import { type ReactNode } from "react";

import { smart } from "../../ui/fields.js";

import { COLOURS } from "./colours.js";

export function Outcome({
  outcome,
  accent,
  note,
}: {
  outcome: HitOutcome;
  accent: string;
  note?: ReactNode;
}): ReactNode {
  const elements = [...outcome.byElement.entries()]
    .filter(([, value]) => value !== 0)
    .sort((a, b) => b[1] - a[1]);

  return (
    <>
      <div className="dmg-total" style={{ color: accent }}>
        {smart(outcome.total)}
      </div>
      {note !== undefined && <div className="faint text-sm">{note}</div>}

      {/*
        The split is kept even when there is only one element in it, and that is deliberate: a
        single row saying "Cold 25,960.11" under a physical skill is the fastest way to see that
        every point of it converted, which is a thing about the build rather than about the hit.
      */}
      <div className="mt-3 mb-4">
        {elements.length === 0 && <div className="faint">No damage.</div>}
        {elements.map(([element, value]) => (
          <div key={element} className="ele-row">
            <span style={{ color: COLOURS[element] ?? "var(--text)" }}>
              {ELEMENTS[element as ElementName]?.displayName || element}
            </span>
            <span className="num">{smart(value)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
