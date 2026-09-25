/**
 * One of the mob's two affix slots, as a list priced by what each affix costs you.
 *
 * A mob rolls at most one prefix and one suffix, so the Config tab asks for one of each rather
 * than a row of checkboxes. Every affix in the slot is priced the way the support gem list prices
 * a gem — the whole document rebuilt with that affix on the enemy, through the same engine the
 * Damage and Defence tabs use — and measured against the same mob with the slot **empty**, not
 * against whatever is picked now. "How much worse does this make the fight" has to have the same
 * zero on every row, or picking one would move every other row's number.
 *
 * The effective HP here is the **physical** row's, not the build's weakest element. A mob's basic
 * attack starts physical (`mobBasicAttack`), and `defence.ts` names each row for what the attacker
 * swings — so Fire Lord moves the physical row, converted and all, and leaves the fire row alone.
 * Ranked on the weakest element instead, a fire-resistant build read Fire Lord as "no change"
 * whenever something else, chaos say, was lower, when three quarters of the mob's hit had just
 * moved onto its best resist.
 *
 * It only moves for affixes that change what the hit is made of or what it walks through —
 * conversion, penetration, accuracy. One that only makes the hit bigger is per point of raw
 * damage the same fight, which is `defence.ts`'s rule and why `savage` reads "no change" here.
 */

import { mobAffixName, type BuildDoc } from "@cte2/schema";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useRanking, type Ranked } from "../../state/compare.js";
import { useWorld } from "../../state/snapshot.js";
import { useGemTooltip } from "../../ui/SpellTooltip.js";
import { mobAffixCard } from "../../ui/spell-stats.js";
import { percent } from "../../ui/format.js";

/** What the list is ordered by. `desc` puts the biggest loss — the worst enemy — on top. */
export type AffixSort = { by: "name" | "dps" | "ehp"; desc: boolean };

/** The empty slot's key. Priced with the rest, because it is the zero every row is read against. */
const NONE = "";

/** Below this a change is float noise, not a measurement. */
const NOISE = 1e-6;

/** Effective HP against the mob's own swing, which starts physical — see the header. */
function swingEhp(vitals: Ranked<string>["vitals"]): number {
  return vitals.ehpByElement.find((e) => e.element === "Physical")?.effectiveHealth ?? vitals.ehp;
}

export function MobAffixPicker({
  kind,
  affixIds,
  value,
  onChange,
  sort,
  mobLevel,
  width = 260,
}: {
  kind: "prefix" | "suffix";
  /** Every affix of this kind the pack declares. */
  affixIds: readonly string[];
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  sort: AffixSort;
  mobLevel: number;
  width?: number;
}): ReactNode {
  const world = useWorld();
  const doc = useBuild((s) => s.doc);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  const candidates = useMemo(() => [NONE, ...affixIds], [affixIds]);

  // The other slot stays as it is: a suffix is priced on a mob that still has your prefix.
  const apply = useCallback(
    (id: string): BuildDoc => {
      const enemy = doc.config?.enemy ?? {};
      const others = (enemy.affixes ?? []).filter((held) => !affixIds.includes(held));
      const next = id === NONE ? others : [...others, id];
      const { affixes: _dropped, ...rest } = enemy;
      return {
        ...doc,
        config: { ...doc.config, enemy: next.length > 0 ? { ...rest, affixes: next } : rest },
      };
    },
    [doc, affixIds],
  );
  const keyOf = useCallback((id: string) => id, []);

  const ranking = useRanking({ candidates, apply, keyOf, enabled: open });

  useEffect(() => {
    if (!open) return;
    const onDocumentDown = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocumentDown);
    return () => document.removeEventListener("mousedown", onDocumentDown);
  }, [open]);

  const bare = ranking.rows.find((row) => row.id === NONE)?.vitals;

  /*
    Sorted here rather than by `useRanking`'s `rank`: that one orders each slice as it lands, so
    flipping the sort after the sweep finished would leave the list in the old order.
  */
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const nameOf = (id: string): string => mobAffixName(world.snapshot, id);
    const matched = ranking.rows.filter(
      (row) =>
        row.id !== NONE &&
        (needle.length === 0 || `${nameOf(row.id)} ${row.id}`.toLowerCase().includes(needle)),
    );
    const figure = (row: Ranked<string>): number =>
      sort.by === "ehp" ? swingEhp(row.vitals) : row.vitals.totalDps;
    return matched.sort((a, b) => {
      if (sort.by !== "name") {
        // Lower figure is a bigger loss, so "biggest loss first" is ascending.
        const diff = sort.desc ? figure(a) - figure(b) : figure(b) - figure(a);
        if (Math.abs(diff) > NOISE) return diff;
      }
      return nameOf(a.id).localeCompare(nameOf(b.id));
    });
  }, [ranking.rows, query, world.snapshot, sort]);

  const selectedName = value === undefined ? "" : mobAffixName(world.snapshot, value);
  const label = kind === "prefix" ? "prefix" : "suffix";

  const commit = (id: string | undefined): void => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="picker" ref={wrapRef} style={{ width }}>
      <input
        type="text"
        value={open ? query : selectedName}
        placeholder={selectedName.length > 0 ? selectedName : `No ${label}`}
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      />

      {open && (
        <div className="picker-list gem-rank-list">
          <div className="gem-rank-head mob-affix-row">
            <span className="faint">
              {sort.by === "name"
                ? "By name"
                : `${sort.desc ? "Worst" : "Easiest"} first, by ${sort.by === "dps" ? "DPS" : "eHP"} lost`}
              {ranking.pending && ` · pricing ${ranking.done} of ${ranking.total}…`}
            </span>
            <span className="faint gem-rank-pct">DPS</span>
            <span className="faint gem-rank-pct">eHP</span>
          </div>
          <div className="picker-option faint" onMouseDown={() => commit(undefined)}>
            (no {label})
          </div>
          {rows.length === 0 && (
            <div className="picker-option faint">{ranking.pending ? "Pricing affixes…" : "No match"}</div>
          )}
          {rows.map((row) => (
            <AffixRow
              key={row.id}
              row={row}
              bare={bare}
              selected={row.id === value}
              mobLevel={mobLevel}
              onPick={() => commit(row.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AffixRow({
  row,
  bare,
  selected,
  mobLevel,
  onPick,
}: {
  row: Ranked<string>;
  /** The same mob with this slot empty; `undefined` until that row has been priced. */
  bare: Ranked<string>["vitals"] | undefined;
  selected: boolean;
  mobLevel: number;
  onPick: () => void;
}): ReactNode {
  const world = useWorld();
  const dps = changeOf(row.vitals.totalDps, bare?.totalDps);
  const ehp = changeOf(swingEhp(row.vitals), bare === undefined ? undefined : swingEhp(bare));

  const note =
    bare === undefined
      ? undefined
      : `Against this mob: ${describe(dps, "Total DPS")}, ` +
        `${describe(ehp, "effective HP against its hit")}.`;
  const card = useMemo(
    () => mobAffixCard(world.snapshot, row.id, { mobLevel }),
    [world.snapshot, row.id, mobLevel],
  );
  const tip = useGemTooltip(
    card === undefined ? undefined : note === undefined ? card : { ...card, note },
  );

  return (
    <div
      className={`picker-option gem-rank-row mob-affix-row${selected ? " active" : ""}`}
      onMouseDown={() => {
        tip.clear();
        onPick();
      }}
      {...tip.props}
    >
      {tip.node}
      <span className="ellipsis gem-rank-name">{mobAffixName(world.snapshot, row.id)}</span>
      <Change fraction={dps} />
      <Change fraction={ehp} />
    </div>
  );
}

function Change({ fraction }: { fraction: number | undefined }): ReactNode {
  if (fraction === undefined) return <span className="faint gem-rank-pct">…</span>;
  if (Math.abs(fraction) <= NOISE) return <span className="faint gem-rank-pct">—</span>;
  return <span className={`gem-rank-pct ${fraction < 0 ? "down" : "up"}`}>{percent(fraction)}</span>;
}

/** `after / before − 1`, or `undefined` when there is nothing to divide by yet. */
function changeOf(after: number, before: number | undefined): number | undefined {
  if (before === undefined || before <= 0) return undefined;
  return after / before - 1;
}

function describe(fraction: number | undefined, what: string): string {
  if (fraction === undefined) return `${what} not measured`;
  if (Math.abs(fraction) <= NOISE) return `${what} unchanged`;
  return `${percent(fraction)} ${what}`;
}
