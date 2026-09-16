/**
 * "What this would change", rendered.
 *
 * One component for every what-if in the app, because the reading is always the same: a label, a
 * signed change, and the size of that change relative to what you had. The second and third are
 * both there deliberately — an absolute change is what you compare between two candidates, and a
 * percentage is what tells you whether a candidate is worth the click at all.
 *
 * Colour is `good`, never the sign. 19 of this pack's stats are better when they go down —
 * cooldowns, costs, the `*_received` families — and `compare` has already resolved which way
 * each one points off `mmorpg_stat.minus_is_good`.
 */

import type { ReactNode } from "react";

import type { Comparison, Delta } from "../state/compare.js";
import { percent, round, signGlyph, smart } from "./format.js";

export function DeltaTable({
  deltas,
  /** Show at most this many rows, with a count of what was left out. */
  limit,
}: {
  deltas: readonly Delta[];
  limit?: number;
}): ReactNode {
  if (deltas.length === 0) return null;
  const shown = limit === undefined ? deltas : deltas.slice(0, limit);
  const hidden = deltas.length - shown.length;

  return (
    <>
      <div className="delta-table">
        {shown.map((d) => (
          <DeltaRow key={d.key} delta={d} />
        ))}
      </div>
      {hidden > 0 && (
        <div className="faint text-sm mt-1">
          and {hidden} more
        </div>
      )}
    </>
  );
}

function DeltaRow({ delta }: { delta: Delta }): ReactNode {
  const tone = delta.good ? "up" : "down";
  return (
    <>
      <span className="delta-label ellipsis" title={delta.key}>
        {delta.label}
      </span>
      <span className={`delta-change ${tone}`} title={`${formatDelta(delta.before, delta.kind)} → ${formatDelta(delta.after, delta.kind)}`}>
        {signed(delta.change, delta.kind)}
      </span>
      <span className={`delta-pct ${tone}`}>
        {delta.fraction === undefined ? "" : percent(delta.fraction)}
      </span>
    </>
  );
}

/**
 * The whole comparison, headline first.
 *
 * The stat list is capped: a single tree node can move sixty stats through a core-stat bundle,
 * and a tooltip that tall covers the tree it is describing.
 */
export function ComparisonBlock({
  comparison,
  statLimit = 8,
  emptyNote = "Changes nothing.",
  stats = true,
}: {
  comparison: Comparison;
  statLimit?: number;
  emptyNote?: string;
  /**
   * Whether to list every sheet stat that moved.
   *
   * Off where the block is a second opinion beside a fuller one — the tree tooltip prices both
   * the node and the whole click, and two sixty-row stat lists in one tooltip is not a tooltip.
   */
  stats?: boolean;
}): ReactNode {
  // `unchanged` is not the test, because it counts rows this block may have been told not to
  // render: a talent granting `+6% Area of Effect` and nothing else moves a sheet stat and no
  // headline figure, so with `stats` off it drew a heading over an empty table.
  const listing = stats && comparison.stats.length > 0;
  if (comparison.headline.length === 0 && !listing) {
    return (
      <div className="faint text-sm">
        {emptyNote}
      </div>
    );
  }

  return (
    <>
      <DeltaTable deltas={comparison.headline} />
      {listing && (
        <div className="delta-section">
          <div className="delta-section-title">Stats</div>
          <DeltaTable deltas={comparison.stats} limit={statLimit} />
        </div>
      )}
    </>
  );
}

/**
 * A value on its own, formatted the way its kind wants.
 *
 * Exported because the Compare tab prints the *absolute* before and after beside the change, and
 * a second implementation of this is how a table ends up reading `47.3%` in one column and
 * `0.473` in the next.
 */
export function formatDelta(value: number, kind: Delta["kind"]): string {
  if (kind === "ratio") return `${(value * 100).toFixed(1)}%`;
  if (kind === "percent") return `${smart(round(value))}%`;
  return smart(round(value));
}

function signed(change: number, kind: Delta["kind"]): string {
  return signGlyph(change) + formatDelta(Math.abs(change), kind);
}
