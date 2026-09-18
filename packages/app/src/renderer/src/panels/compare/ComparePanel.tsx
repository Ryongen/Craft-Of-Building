/**
 * Two builds, side by side.
 *
 * Path of Building's second-best idea, after pricing a click before you make it: pin the build
 * you have, change whatever you like, and read what it cost. The app could already price a
 * *single* change — a support gem, a tree node — but a session's worth of them had no answer at
 * all. You re-geared a character over twenty minutes and the only thing that could tell you
 * whether it was better was your memory of a number in the topbar.
 *
 * ## What is actually new here
 *
 * Almost nothing, which is the point. `vitalsOf` takes any document and `compare` takes any two
 * sets of vitals, so "compare two builds" was already written — it had no second document and
 * nowhere to show it. This panel is those two things: `state/build-store`'s `baseline` slice, and
 * the tables below.
 *
 * ## The rule this panel keeps
 *
 * **The baseline is frozen.** Every control here either replaces what is pinned or drops it;
 * there is no path from this panel to a modifier on the pinned document. That is the standing
 * rule about connected state — a value that shows in two panels comes from one computation, and
 * the write goes to one place. A Compare tab that let you toggle an effect on the baseline would
 * be a second place that effect lives, and the two would disagree the moment anyone used it.
 */

import { statName } from "@cte2/schema";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { HEADLINE, useBaselineComparison, type BaselineComparison } from "../../state/compare.js";
import { useWorld } from "../../state/snapshot.js";
import { DeltaTable, formatDelta } from "../../ui/DeltaTable.js";
import { EMPTY, percent, signGlyph } from "../../ui/format.js";
import { elementLabel } from "../../ui/palette.js";
import { SearchInput } from "../../ui/SearchInput.js";

export function ComparePanel(): ReactNode {
  const baseline = useBuild((s) => s.baseline);
  const pinBaseline = useBuild((s) => s.pinBaseline);
  const setBaseline = useBuild((s) => s.setBaseline);
  const clearBaseline = useBuild((s) => s.clearBaseline);
  const swapBaseline = useBuild((s) => s.swapBaseline);
  const against = useBaselineComparison();

  const openAsBaseline = useCallback(async () => {
    const result = await window.cte2.openBuild();
    if (result.ok) setBaseline(result.doc, result.doc.meta?.name ?? fileLabel(result.path));
    else if (!result.cancelled && result.error !== undefined) {
      // eslint-disable-next-line no-alert
      alert(`Could not open that build as a baseline:\n\n${result.error}`);
    }
  }, [setBaseline]);

  if (baseline === null || against === null) {
    return (
      <div className="panel">
        <div className="prose">
          <div className="notice info">
            <strong>Nothing is pinned.</strong> Pin the build you have now and every change you
            make afterwards is measured against it — the whole re-gearing session, not one click
            at a time. Or open a saved build to compare the current one against that.
          </div>
          <div className="row gap-4 mt-4">
            <button className="primary" onClick={() => pinBaseline()}>
              Pin current build
            </button>
            <button onClick={() => void openAsBaseline()}>Open a build as baseline…</button>
          </div>
          <p className="faint text-sm mt-5">
            A baseline is session state, not part of either document: nothing is written to the
            build you are editing, and nothing you do here can change the pinned one.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="card">
        <div className="row gap-5" style={{ alignItems: "baseline" }}>
          <span className="section-title" style={{ margin: 0 }}>
            Baseline
          </span>
          <strong className="ellipsis" title={baseline.name}>
            {baseline.name}
          </strong>
          <span className="faint text-sm">pinned {sinceLabel(baseline.pinnedAt)}</span>
          <div className="spacer" />
          <button
            onClick={() => pinBaseline()}
            title="Replace the baseline with the build as it stands now"
          >
            Re-pin to current
          </button>
          <button
            onClick={swapBaseline}
            title="Edit the pinned build instead, and pin the one you have open"
          >
            Swap
          </button>
          <button onClick={() => void openAsBaseline()}>Open another…</button>
          <button onClick={clearBaseline}>Clear</button>
        </div>
      </div>

      {against.comparison.unchanged ? (
        <div className="notice">
          <strong>Identical to the baseline.</strong> Every figure and every stat matches, so
          whatever has changed since pinning does not reach a number this app computes.
        </div>
      ) : (
        <div className="compare-body">
          <HeadlineTable against={against} />
          <ElementTable against={against} />
          <StatList against={against} />
        </div>
      )}
    </div>
  );
}

/**
 * The figures a build is read by, both values and the move between them.
 *
 * Every row of `HEADLINE` is listed whether or not it moved, which is the difference between this
 * and the same block in a tooltip: a tooltip answers "what would this click do", where an unmoved
 * row is noise, while this answers "what are these two builds", where a row reading *unchanged*
 * is information. The changes themselves still come from `compare` and are never recomputed here
 * — a second opinion about which direction counts as better is exactly what `minus_is_good`
 * exists to prevent.
 */
function HeadlineTable({ against }: { against: BaselineComparison }): ReactNode {
  const { before, after } = against;
  const moved = useMemo(
    () => new Map(against.comparison.headline.map((d) => [d.key, d])),
    [against.comparison.headline],
  );

  return (
    <table className="contribs mb-5">
      <thead>
        <tr>
          <th>Figure</th>
          <th className="right">Baseline</th>
          <th className="right">Current</th>
          <th className="right">Change</th>
          <th className="right">%</th>
        </tr>
      </thead>
      <tbody>
        {HEADLINE.map((row) => {
          const delta = moved.get(row.key);
          const tone = delta === undefined ? "faint" : delta.good ? "up" : "down";
          return (
            <tr key={row.key}>
              <td>{row.label}</td>
              <td className="n faint">{formatDelta(before[row.key] as number, row.kind)}</td>
              <td className="n">{formatDelta(after[row.key] as number, row.kind)}</td>
              <td className={`n ${tone}`}>
                {delta === undefined
                  ? EMPTY
                  : signGlyph(delta.change) + formatDelta(Math.abs(delta.change), row.kind)}
              </td>
              <td className={`n ${tone}`}>
                {delta?.fraction === undefined ? EMPTY : percent(delta.fraction)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Effective HP per element.
 *
 * Its own table rather than more headline rows, because the headline carries only the *weakest*
 * element and that one figure hides the commonest defensive change there is: buying fire
 * resistance on a character whose cold is worse moves nothing at the top of the page. Reading
 * "Effective HP unchanged" after spending four passives on resistance is worse than reading
 * nothing at all.
 */
function ElementTable({ against }: { against: BaselineComparison }): ReactNode {
  const { before, after } = against;
  const moved = useMemo(
    () =>
      new Map(against.comparison.ehpByElement.map((d) => [d.key.slice(4), d])),
    [against.comparison.ehpByElement],
  );

  const baselineByElement = new Map(before.ehpByElement.map((e) => [e.element, e.effectiveHealth]));
  if (after.ehpByElement.length === 0) return null;

  return (
    <>
      <div className="section-title">Effective HP by element</div>
      <table className="contribs mb-5">
        <thead>
          <tr>
            <th>Element</th>
            <th className="right">Baseline</th>
            <th className="right">Current</th>
            <th className="right">Change</th>
          </tr>
        </thead>
        <tbody>
          {after.ehpByElement.map((entry) => {
            const delta = moved.get(entry.element);
            const tone = delta === undefined ? "faint" : delta.good ? "up" : "down";
            const weakestNow = entry.element === after.weakestElement;
            return (
              <tr key={entry.element}>
                <td>
                  {elementLabel(entry.element)}
                  {/* The one row that decides the headline figure, said rather than implied —
                      and, when it has changed, which row used to decide it. */}
                  {weakestNow && (
                    <span className="badge" style={{ marginLeft: 6 }}>
                      weakest
                    </span>
                  )}
                  {before.weakestElement === entry.element && !weakestNow && (
                    <span className="badge warn" style={{ marginLeft: 6 }}>
                      was weakest
                    </span>
                  )}
                </td>
                <td className="n faint">
                  {formatDelta(baselineByElement.get(entry.element) ?? 0, "number")}
                </td>
                <td className="n">{formatDelta(entry.effectiveHealth, "number")}</td>
                <td className={`n ${tone}`}>
                  {delta === undefined
                    ? EMPTY
                    : signGlyph(delta.change) + formatDelta(Math.abs(delta.change), "number")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/**
 * Every sheet stat that moved, searchable.
 *
 * Uncapped, unlike the tooltip's copy: a tree node can move sixty stats through one core-stat
 * bundle and a tooltip that tall covers the tree it is describing, but a tab is where you go
 * precisely to read the long version. The filter is here because a re-gearing session moves
 * enough of them that finding the one you were watching is the slow part.
 */
function StatList({ against }: { against: BaselineComparison }): ReactNode {
  const { snapshot } = useWorld();
  const [query, setQuery] = useState("");
  const all = against.comparison.stats;

  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      needle.length === 0
        ? all
        : all.filter(
            (d) =>
              d.key.toLowerCase().includes(needle) ||
              statName(snapshot, d.key).toLowerCase().includes(needle),
          ),
    [all, needle, snapshot],
  );

  if (all.length === 0) {
    return (
      <div className="faint text-sm">
        No sheet stat moved. Everything above comes from the skill, the rotation or the target
        rather than from the character — a support gem&rsquo;s stats go onto the spell unit, never
        onto the sheet.
      </div>
    );
  }

  return (
    <>
      <div className="row gap-4 mb-3" style={{ alignItems: "baseline" }}>
        <div className="section-title" style={{ margin: 0 }}>
          Stats that moved
        </div>
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={`Filter ${all.length} stats…`}
          width={200}
        />
      </div>
      {shown.length === 0 ? (
        <div className="faint text-sm">Nothing matches “{query}”.</div>
      ) : (
        <DeltaTable deltas={shown} />
      )}
    </>
  );
}

/** A file name without its directory or its extension, for naming a baseline opened from disk. */
function fileLabel(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.json$/i, "");
}

/**
 * How long ago something was pinned, in the coarsest unit that is still true.
 *
 * Coarse on purpose: the useful question is whether the baseline is from this session or from
 * yesterday, and a seconds-accurate label would have to re-render to stay honest.
 */
function sinceLabel(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "just now";
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
