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
 *
 * A row that moved by less than {@link MINOR} is painted in a muted version of the same
 * colour. The list is ranked, so those collect at the bottom, and a build is read by what
 * moved *enough to matter* — a wall of ten equally bright rows makes the reader find that
 * boundary themselves, every time.
 *
 * ## Why a row is an element
 *
 * The label column takes the slack and the numbers are pinned right, so a wide card leaves a
 * long gap between a stat's name and its number, and twenty of those stacked is a list the eye
 * loses its place in. Three loose cells per row cannot be striped or hovered together, so each
 * row is its own `subgrid` across all three tracks — the columns stay aligned across every row,
 * and the row gains a box to band and to light up under the pointer. See `.delta-row`.
 */

import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { Comparison, Delta } from "../state/compare.js";
import { USABLE_NOUN, num, percent, round, signGlyph, smart, usable } from "./format.js";

/**
 * Below this fraction a change is real but not worth looking at — a tenth of a percent.
 *
 * Absolute rather than relative to the biggest mover in the list: a threshold that floats with
 * the largest row would dim a solid 3% gain simply because something else in the same click
 * doubled, and "is this worth reading" is a question about the number itself.
 */
const MINOR = 0.001;

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
  const [at, setAt] = useState<At | null>(null);
  const track = useCallback((event: React.MouseEvent) => {
    setAt({ x: event.clientX, y: event.clientY });
  }, []);
  const clear = useCallback(() => setAt(null), []);
  const tone = toneOf(delta);

  return (
    // The hover is on the row rather than on the number alone, so following a line with the
    // pointer — which is what the row highlight is for — also brings up what the figure was and
    // what it became.
    <div className="delta-row" onMouseEnter={track} onMouseMove={track} onMouseLeave={clear}>
      <span className="delta-label ellipsis">{delta.label}</span>
      <span className={`delta-change ${tone}`}>{signedChange(delta)}</span>
      <span className={`delta-pct ${tone}`}>
        {delta.fraction === undefined ? "" : percent(delta.fraction)}
      </span>
      {at !== null && createPortal(<DeltaTip delta={delta} at={at} />, document.body)}
    </div>
  );
}

/**
 * Green or red, and how loudly.
 *
 * A change from zero has no fraction and is never minor: it is a figure the build did not have
 * at all, which is the largest kind of change there is.
 */
function toneOf(delta: Delta): string {
  const minor = delta.fraction !== undefined && Math.abs(delta.fraction) < MINOR;
  return `${delta.good ? "up" : "down"}${minor ? " minor" : ""}`;
}

/**
 * The cell: what the change *is*.
 *
 * For the five `IUsableStat` families that is two numbers, and the useful one leads. `+120`
 * armour is unpriceable on its own — the curve is hyperbolic, so the same 120 is four points
 * of mitigation on a bare character and a tenth of one on a geared one — while
 * `+1.35% (+120)` says both what you gained and where it came from.
 */
function signedChange(delta: Delta): string {
  const flat = signed(delta.change, delta.kind);
  if (delta.beforeUsable === undefined || delta.afterUsable === undefined) return flat;
  const moved = delta.afterUsable - delta.beforeUsable;
  // A rating that moved without moving the mitigation is worth saying plainly rather than
  // dressing up as `+0.00%`: past the knee of the curve that is exactly what more armour buys.
  if (Math.abs(moved) < 0.005) return `±0% (${flat})`;
  return `${signGlyph(moved)}${num(Math.abs(moved), 2)}% (${flat})`;
}

type At = { x: number; y: number };

/**
 * The card's assumed size, for flipping it near the edge of the window.
 *
 * Assumed rather than measured, the same bargain `ItemTooltip` makes: measuring would cost a
 * second render on every mouse move, and being a few dozen pixels out only ever matters within a
 * card's width of an edge.
 */
const TIP = { width: 260, height: 64 };

/**
 * The hover: what the row is about, and what its figure *was* and is now.
 *
 * A card of the app's own rather than a `title` attribute. The browser's tooltip arrives half a
 * second late in the desktop's colours, and — the reason it had to go — it takes one flat string,
 * so a stat's name and its two values could only be stacked as lines of the same text. Here the
 * name is a heading over the change.
 *
 * The name is the label the row already carries, which for a sheet stat is the in-game one
 * `statDisplay` resolves. The stat id used to be printed under it, and an id on screen reads as
 * the variable name having leaked out of the data — which is what it was.
 */
function DeltaTip({ delta, at }: { delta: Delta; at: At }): ReactNode {
  const { beforeUsable, afterUsable } = delta;
  // The five `IUsableStat` families print what the rating bought as well as the rating itself,
  // because the rating alone is not a figure anyone can price — see `usable`.
  const priced = beforeUsable !== undefined && afterUsable !== undefined;
  const before = priced ? usable(beforeUsable, delta.before) : formatDelta(delta.before, delta.kind);
  const after = priced ? usable(afterUsable, delta.after) : formatDelta(delta.after, delta.kind);

  return (
    <div className="delta-tip" style={tipStyle(at)}>
      <div className="delta-tip-name">{delta.label}</div>
      <div className="delta-tip-change">
        <span className="was">{before}</span>
        <span className="arrow">→</span>
        <span className={toneOf(delta)}>{after}</span>
      </div>
      {priced && <div className="delta-tip-noun">{USABLE_NOUN[delta.key] ?? "effective"}</div>}
    </div>
  );
}

/**
 * Where to put the card, given the pointer.
 *
 * Flipped towards the inside of the window when it would otherwise run off the right or the
 * bottom edge. Delta rows live in panels down the right-hand side and at the foot of cards, so
 * that is the common case here rather than the edge case.
 */
function tipStyle(at: At): CSSProperties {
  const flipX = at.x > window.innerWidth - TIP.width - 24;
  const flipY = at.y > window.innerHeight - TIP.height - 24;
  return {
    left: flipX ? undefined : at.x + 14,
    right: flipX ? window.innerWidth - at.x + 14 : undefined,
    top: flipY ? undefined : at.y + 18,
    bottom: flipY ? window.innerHeight - at.y + 18 : undefined,
  };
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
