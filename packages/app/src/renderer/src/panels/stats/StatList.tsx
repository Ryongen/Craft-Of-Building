/**
 * Every stat the build resolved, grouped, filtered and complete.
 *
 * This used to be the bottom four fifths of the sidebar, under the vitals block. It is on the
 * Stats tab now, and the move is the point rather than a side effect: the sidebar is read
 * *while you click* — it answers "what is my effective HP now" between edits — and a 223-row
 * scrolling list with its own search box and its own sticky header is not something anybody
 * reads that way. It is a reference, and a reference belongs on the screen you go to.
 *
 * What it must not lose by moving is completeness. The curated boxes above it on this tab are a
 * chosen set per subject and a stat missing from all of them is not lost, because this is here
 * and this is exhaustive — the same contract the sidebar used to hold. `SHEET_GROUPS` in
 * `@cte2/schema` authors the section order and the order inside each section, because the pack
 * cannot: 536 of its 832 stats declare `group: Misc`, another 191 declare nothing at all, and
 * every stat that declares `order` declares 100.
 *
 * Two things the data still does not do are handled here: 327 stat names are templates rather
 * than labels, so the value is spliced into the name instead of printed after it; and the four
 * `IUsableStat` stats have a second number that is the one people actually want — 1,575.9
 * armour is 43.1% mitigation, and the raw value alone does not say so.
 */

import {
  compareForSheet,
  fillTemplate,
  sheetGroupName,
  sheetGroupOf,
  sheetGroupRank,
  statDesc,
  statDisplay,
  statNameRaw,
  stripFormatting,
  type StatDisplay,
} from "@cte2/schema";
import type { EngineStat } from "@cte2/engine";
import { useMemo, useState, type ReactNode } from "react";

import { useDerived } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { USABLE_NOUN, num, smart } from "../../ui/format.js";
import { SearchInput } from "../../ui/SearchInput.js";
import { StatIcon } from "../../ui/StatIcon.js";
import { statLook } from "../../ui/stat-look.js";
import { useTechnical } from "../../ui/detail-mode.js";

export type SheetRow = {
  display: StatDisplay;
  stat: EngineStat;
  /** The name with `[VAL1]` filled in, when the name is a template. */
  label: string;
  /**
   * The pack's own one-line explanation, where it has one.
   *
   * `mmorpg.stat_desc.<id>` — "Decreases physical damage taken by a percent" for `armor`. Not
   * every stat has one, which is why the id is still the fallback rather than being replaced:
   * for a stat the pack never described, the id is the most useful thing a hover can say.
   */
  desc: string | undefined;
};

export function StatList({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (statId: string | null) => void;
}): ReactNode {
  const { snapshot } = useWorld();
  const derived = useDerived();
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  const groups = useMemo(() => {
    const rows: SheetRow[] = [];
    for (const [statId, stat] of derived.stats) {
      const display = statDisplay(snapshot, statId);

      // Default view: what the game's own sheet would show, and only where it has a value.
      // `show_in_gui: false` is the pack's own call about 10 internal stats.
      if (!showAll) {
        if (!display.showInGui) continue;
        if (stat.value === 0 && stat.dmgMulti === 1) continue;
      }

      const raw = statNameRaw(snapshot, statId);
      const label =
        display.templated && raw !== undefined
          ? stripFormatting(fillTemplate(raw, [stat.value]))
          : display.name;

      rows.push({ display, stat, label, desc: statDesc(snapshot, statId) });
    }

    const needle = query.trim().toLowerCase();
    const filtered =
      needle.length === 0
        ? rows
        : rows.filter(
            (row) =>
              row.label.toLowerCase().includes(needle) ||
              row.display.id.toLowerCase().includes(needle),
          );

    filtered.sort((a, b) => compareForSheet(snapshot, a.display, b.display));

    // Grouping after sorting keeps one ordering rule rather than two that can disagree: the
    // comparator decides both which section a row is in and where it sits inside it, so the
    // map below is filled in final order and never re-sorted.
    const byGroup = new Map<string, SheetRow[]>();
    for (const row of filtered) {
      const group = sheetGroupOf(snapshot, row.display.id);
      const list = byGroup.get(group);
      if (list) list.push(row);
      else byGroup.set(group, [row]);
    }

    return [...byGroup].sort(([a], [b]) => sheetGroupRank(a) - sheetGroupRank(b));
  }, [derived.stats, snapshot, query, showAll]);

  const shown = groups.reduce((n, [, rows]) => n + rows.length, 0);

  return (
    <div className="stat-list">
      <div className="row wrap mb-3">
        <SearchInput
          placeholder={`Filter ${derived.stats.size} stats…`}
          value={query}
          onChange={setQuery}
        />
        <button
          onClick={() => setShowAll((v) => !v)}
          title={
            showAll
              ? "Showing every stat the engine resolved, including zeroes and hidden ones"
              : "Showing stats with a value that the game's own sheet displays"
          }
        >
          {showAll ? "All" : "Active"}
        </button>
        <span className="faint text-sm">
          {shown} shown
          {selected === null ? ". Click one to see where it comes from" : ""}
        </span>
      </div>

      {shown === 0 && <div className="empty">No stat matches.</div>}

      {/*
        Laid out in however many columns the tab is wide enough for, rather than one tall
        scroller. A section never breaks across a column — `break-inside: avoid` — because the
        heading is what makes the rows under it mean anything.
      */}
      <div className="stat-list-columns">
        {groups.map(([group, rows]) => (
          <div key={group} className="sheet-section">
            <div className="section-title">
              {sheetGroupName(group)} <span className="faint">({rows.length})</span>
            </div>
            {rows.map((row) => (
              <StatRow
                key={row.display.id}
                row={row}
                selected={row.display.id === selected}
                onSelect={() => onSelect(row.display.id === selected ? null : row.display.id)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function StatRow({
  row,
  selected,
  onSelect,
}: {
  row: SheetRow;
  selected: boolean;
  onSelect: () => void;
}): ReactNode {
  const [technical] = useTechnical();
  const { snapshot } = useWorld();
  const { display, stat, label, desc } = row;
  const capped = stat.hardcap > 0 && stat.value >= stat.hardcap;
  // `minus_is_good` is the pack's own flag for the stats where down is up — cooldowns, costs,
  // `dmg_received`. Without it a −15% mana cost renders in the same red as −15% health.
  //
  // Zero is neither, and saying so matters: a stat sitting at 0 with a MORE multiplier is a
  // real row on this sheet, and painting it red claimed something bad had happened to it.
  const tone = stat.value === 0 ? "" : (display.minusIsGood ? stat.value < 0 : stat.value > 0) ? " good" : " bad";

  return (
    <div className={`stat-row${selected ? " selected" : ""}`} onClick={onSelect}>
      <StatIcon statId={display.id} />
      {/* The description where the pack wrote one, and the id only where it did not — hovering
          a stat to be told its own id back is the one thing a tooltip here cannot usefully do. */}
      <span
        className="name"
        style={{ color: statLook(snapshot, display.id).colour }}
        title={
          technical
            ? desc === undefined
              ? display.id
              : `${desc}

${display.id}`
            : desc
        }
      >
        {label}
      </span>

      {/* A MULTIPLICATIVE_DAMAGE stat keeps its MORE modifiers out of the value on purpose;
          they are spent once, later, in the damage layer. Hiding this is how a planner ends
          up quietly wrong on exactly the stats that decide damage. */}
      {stat.dmgMulti !== 1 && (
        <span
          className="badge warn"
          title="MORE multiplier, held back for the damage layer rather than included above"
        >
          ×{smart(stat.dmgMulti)}
        </span>
      )}

      {capped && (
        <span className="badge bad" title={`Hard cap: ${smart(stat.hardcap)}`}>
          cap
        </span>
      )}

      {!display.templated && (
        <span className={`value${tone}`}>
          {/*
            The percent leads and the rating follows it in brackets: `56.29% (2,679)`.
            It used to be the other way round, with the noun spelled out inline, and that put the
            number nobody can act on in the reading position. 2,679 armour is a rating on a
            hyperbolic curve — the only question ever asked of it is what share of a hit it stops,
            and the same +120 is worth four points of mitigation on a bare character and a tenth
            of one here. The noun moved to the hover to buy the width back.
          */}
          {stat.usableValue === undefined ? (
            <>
              {smart(stat.value)}
              {display.isPerc ? "%" : ""}
            </>
          ) : (
            <span
              title={`${smart(stat.usableValue)}% ${USABLE_NOUN[display.id] ?? "effective"} in play`}
            >
              {num(stat.usableValue, 2)}%{" "}
              <span className="usable">({smart(stat.value)})</span>
            </span>
          )}
        </span>
      )}
    </div>
  );
}
