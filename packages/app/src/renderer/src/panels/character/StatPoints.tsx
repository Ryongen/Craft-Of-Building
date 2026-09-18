/**
 * Spending level-up points on strength, dexterity and intelligence.
 *
 * This is the mod's own `MainHubScreen` allocation, reproduced against the same rules the
 * server enforces rather than against a screenshot of it:
 *
 *  - **which stats** — `AllocateStatPacket.onReceived` rejects anything that is not a
 *    `CoreStat`, so the rows come from `coreStatIds`, which filters `mmorpg_stat` on the
 *    `core_stat` serializer. Hardcoding the three would quietly go wrong the day the pack adds
 *    a fourth, and would also have swept up the 20 `bonus_stat_per_effect` stats that carry a
 *    `core_stat_data` block without being core stats.
 *  - **how many** — `PlayerPointsType.getFreePoints` is
 *    `base_points + (int)(lvl * points_per_lvl)`, capped at `max_total_points`, which for
 *    `original_balance` is one per level capped at 300. The `+` buttons stop there, the way
 *    the packet's `if (getFreePoints(player) < 1) break;` does.
 *  - **what a point is worth** — exactly +1, at every level. `StatPointsData` passes a literal
 *    `1` as the level to `ExactStatData.levelScaled`, and `CORE_STAT_SCALING` at level 1 is 1.
 *    Levelling grants more points; it never inflates the ones already spent.
 *
 * `max_bonus_points` (50) is deliberately *not* spendable here. Those come from quests and
 * items that a build document has no field for, so the budget shown is what levelling gives;
 * the validator downgrades a spend past it to a warning rather than an error, and the note at
 * the bottom says why.
 *
 * What each point *does* is not modelled here at all. `CoreStat.affectStats` expands the stat
 * into its bundle during the engine's core-stat pass, so the "grants" column is read off
 * `core_stat_data` for display and the sheet in the sidebar is the authority.
 *
 * ## Why it is a component rather than a tab
 *
 * It had a tab of its own, and the tab was mostly empty: three rows and a paragraph. Points are
 * spent in the same session as tree points and almost never on their own, so it lives in the
 * tree's overlay now, under the three tree buttons — see `compact`, which is the version that
 * fits there.
 */

import {
  CATEGORY,
  coreStatIds,
  entry,
  modifierLine,
  statDesc,
  statName,
  pointsAvailable,
} from "@cte2/schema";
import { useMemo, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useDerived } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { NumberField } from "../../ui/fields.js";
import { smart } from "../../ui/format.js";

/** `AllocateStatPacket.MAX_ALLOCATE_AT_ONCE` — what a shift-click sends. */
const SHIFT_STEP = 5;

export function StatPoints({
  compact = false,
}: {
  /**
   * Drop the prose and the `+5` button, for the tree overlay.
   *
   * The explanation is worth reading once and is not worth 120px of a canvas you are clicking
   * nodes on. What survives is the part you come back to: how many points are unspent, where
   * they went, and what each stat totals once gear is counted.
   */
  compact?: boolean;
}): ReactNode {
  const { snapshot } = useWorld();
  const doc = useBuild((s) => s.doc);
  const setStatPoints = useBuild((s) => s.setStatPoints);
  const clearStatPoints = useBuild((s) => s.clearStatPoints);
  const derived = useDerived();

  const coreStats = useMemo(() => coreStatIds(snapshot), [snapshot]);
  // A capture records `getFreePoints`, which includes the quest and item bonus points this
  // panel deliberately does not offer to spend. Where it is present it is the answer, not an
  // estimate — so the counter reads the game's own number instead of the level-derived floor.
  const points = useMemo(
    () => pointsAvailable(snapshot, doc.character, "STATS"),
    [snapshot, doc.character],
  );
  const budget = points.budget;

  const allocated = doc.character.statPoints ?? {};
  const spent = Object.values(allocated).reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
  const available = points.total;
  const free = available - spent;

  if (coreStats.length === 0) {
    return compact ? null : (
      <div className="notice">
        No stat in this snapshot uses the <code>core_stat</code> serializer, so there is
        nothing a level-up point could be spent on. That would be a pack change worth looking
        at rather than something to work around here.
      </div>
    );
  }

  return (
    <>
      <div className="row wrap mb-3">
        <strong>
          {free} point{free === 1 ? "" : "s"} unspent
        </strong>
        <span
          className="faint text-sm"
          title={
            points.recorded
              ? "What the game reported for this character, bonus points included"
              : `Level ${doc.character.level} grants ${budget === undefined ? "?" : budget.fromLevel}. Up to ${budget?.maxBonus ?? 0} more come from quests and items, which a build document cannot record.`
          }
        >
          {spent} of {available} spent
          {!points.recorded && budget !== undefined && budget.fromLevel === budget.maxTotal
            ? ` (the ${budget.maxTotal} cap)`
            : ""}
        </span>
        <span className="grow" />
        <button disabled={spent === 0} onClick={clearStatPoints}>
          Reset
        </button>
      </div>

      {free < 0 && (
        <div className="notice">
          <strong>{-free} points over budget.</strong>{" "}
          {points.recorded ? (
            <>
              The game reported {available} stat points for this character, bonus points
              included, so this spend is not one it would have allowed.
            </>
          ) : (
            <>
              Levelling to {doc.character.level} grants {available}. Up to{" "}
              {budget?.maxBonus ?? 0} more are obtainable in game from sources a build document
              cannot record, so this is legal up to {budget?.ceiling ?? available} — just not
              verifiable here.
            </>
          )}
        </div>
      )}

      {coreStats.map((statId) => (
        <CoreStatRow
          key={statId}
          statId={statId}
          points={allocated[statId] ?? 0}
          free={free}
          compact={compact}
          total={derived.stats.get(statId)?.value}
          onChange={(next) => setStatPoints(statId, next)}
        />
      ))}

      {!compact && (
        <div className="faint text-sm mt-5" style={{ lineHeight: 1.5 }}>
          One point is <strong>+1</strong>, at every character level —{" "}
          <code>StatPointsData</code> passes a hardcoded level of 1 to{" "}
          <code>ExactStatData.levelScaled</code>, and the core-stat scaling curve at level 1 is
          exactly 1. Levelling grants more points; it never makes the ones you already spent
          worth more.
          <br />
          The <strong>total</strong> is the stat on the character sheet, which includes gear,
          perks and auras as well as these points. What each point grants is applied by the
          engine&apos;s core-stat pass, so a percentage bonus to the granted stat reaches what the
          attribute itself granted.
        </div>
      )}
    </>
  );
}

function CoreStatRow({
  statId,
  points,
  free,
  total,
  compact,
  onChange,
}: {
  statId: string;
  points: number;
  /** Unspent points, so the steppers can stop where the packet would. */
  free: number;
  /** The stat's value on the character sheet — points plus everything else. */
  total: number | undefined;
  compact: boolean;
  onChange: (points: number) => void;
}): ReactNode {
  const { snapshot } = useWorld();

  /** `core_stat_data.stats` — the bundle one point of this attribute grants. */
  const grants = useMemo(() => {
    const data = entry(snapshot, CATEGORY.stat, statId)?.data;
    const inner = data?.["data"];
    const node = inner !== null && typeof inner === "object" ? (inner as Record<string, unknown>) : {};
    const bundle = node["core_stat_data"];
    const stats =
      bundle !== null && typeof bundle === "object"
        ? (bundle as Record<string, unknown>)["stats"]
        : undefined;
    return Array.isArray(stats)
      ? stats.filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
      : [];
  }, [snapshot, statId]);

  const step = (by: number): void => onChange(Math.max(0, points + by));
  const canAdd = free > 0;

  return (
    <div className={compact ? "mb-2" : "mb-4"}>
      <div className="alloc-row">
        <span
          className="alloc-name"
          title={
            grants.length === 0
              ? (statDesc(snapshot, statId) ?? statId)
              : `${statDesc(snapshot, statId) ?? statId}

per point: ${grants.map((mod) => modifierLine(snapshot, mod, 0)).join(" · ")}`
          }
        >
          {statName(snapshot, statId)}
        </span>

        <button
          className="nudge"
          disabled={points <= 0}
          title="Remove a point"
          onClick={() => step(-1)}
        >
          −
        </button>
        <NumberField
          value={points}
          min={0}
          width={compact ? 46 : 58}
          onChange={(next) => onChange(Math.max(0, Math.round(next)))}
        />
        <button className="nudge" disabled={!canAdd} title="Spend a point" onClick={() => step(1)}>
          +
        </button>
        {/* `AllocateStatPacket.MAX_ALLOCATE_AT_ONCE` is 5, which is what shift-clicking sends. */}
        {!compact && (
          <button
            disabled={!canAdd}
            title={`Spend ${SHIFT_STEP} (what a shift-click sends in game)`}
            onClick={() => step(Math.min(SHIFT_STEP, Math.max(free, 0)))}
          >
            +{SHIFT_STEP}
          </button>
        )}

        <span className="grow" />
        {!compact && <span className="faint text-sm">total</span>}
        <span className="alloc-count" title="On the character sheet: these points plus gear, perks and auras">
          {total === undefined ? "—" : smart(total)}
        </span>
      </div>

      {/* The grants list is on the name's hover in compact mode — three more lines is most of
          the height this block has on a canvas. */}
      {!compact && grants.length > 0 && (
        <div className="faint text-sm" style={{ paddingLeft: 8 }}>
          per point:{" "}
          {grants.map((mod, index) => (
            <span key={index}>
              {index > 0 ? " · " : ""}
              {modifierLine(snapshot, mod, 0)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
