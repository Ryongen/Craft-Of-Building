/**
 * Notables and gamechangers, ranked by what they buy per point spent reaching them.
 *
 * Every candidate is priced as the click that would take it: the node **and the path to it**,
 * through the same `candidateFor` the hover tooltip uses. A notable six points away is six points
 * of travel stats plus the notable, and dividing its gain by one would rank it above a closer
 * node that is actually the better buy. So the divisor is the path length and the gain includes
 * whatever the travel nodes grant.
 *
 * Only `SPECIAL` and `MAJOR` perks are candidates. A full engine pass is about 30 ms, and the
 * talent tree has ~1,200 unallocated nodes, most of them small flats nobody plans a route
 * around; the ~375 notables and gamechangers are what a player is choosing between, and pricing
 * them is ten seconds rather than forty. The nearest are priced first, so the list is useful
 * well before it is finished.
 */

import { perkName, shortestPathTo, type NodeKey, type TreeGraph, type TreeKey } from "@cte2/schema";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useRanking, type Ranked, type Vitals } from "../../state/compare.js";
import { percent, round, signGlyph, smart, useWorld } from "@cte2/view";

import { candidateFor } from "./candidate.js";

type Candidate = { key: NodeKey; perkId: string; major: boolean; path: readonly NodeKey[] };

type Metric = { id: string; label: string; of: (vitals: Vitals) => number };

const HEADLINE_METRICS: Metric[] = [
  { id: "totalDps", label: "Total DPS", of: (v) => v.totalDps },
  { id: "fullDps", label: "Full DPS", of: (v) => v.fullDps },
  { id: "dps", label: "Skill DPS", of: (v) => v.dps },
  { id: "ehp", label: "Effective HP", of: (v) => v.ehp },
  { id: "pool", label: "Life + magic shield", of: (v) => v.pool },
];

const STAT_PREFIX = "stat:";

type SortBy = "perPoint" | "gain" | "points";

const MAX_POINTS = [undefined, 5, 10, 15, 20] as const;

/** Below this a change is float noise, not a gain. */
const NOISE = 1e-6;

export function NodeRanking({
  tree,
  graph,
  allocated,
  onPreview,
  onFocus,
}: {
  tree: TreeKey;
  graph: TreeGraph;
  allocated: ReadonlySet<NodeKey>;
  onPreview: (keys: ReadonlySet<NodeKey> | undefined) => void;
  onFocus: (key: NodeKey) => void;
}): ReactNode {
  const world = useWorld();
  const doc = useBuild((s) => s.doc);
  const allocateNodes = useBuild((s) => s.allocateNodes);

  // A row's path stays drawn only while the cursor is on it; leaving the tab must not strand it.
  useEffect(() => () => onPreview(undefined), [onPreview]);

  const [metricId, setMetricId] = useState("totalDps");
  const [sortBy, setSortBy] = useState<SortBy>("perPoint");
  const [majorOnly, setMajorOnly] = useState(false);
  const [maxPoints, setMaxPoints] = useState<number | undefined>(undefined);

  // The filters narrow what gets *priced*, not just what is shown: "gamechangers within 10" is
  // a few dozen engine passes where the whole tree is hundreds.
  const candidates = useMemo<Candidate[]>(() => {
    const out: Candidate[] = [];
    for (const node of graph.nodes.values()) {
      const type = node.perk?.type;
      if (type !== "SPECIAL" && type !== "MAJOR") continue;
      if (majorOnly && type !== "MAJOR") continue;
      if (allocated.has(node.key)) continue;
      const path = shortestPathTo(graph, allocated, node.key);
      if (path === undefined || path.length === 0) continue;
      if (maxPoints !== undefined && path.length > maxPoints) continue;
      out.push({ key: node.key, perkId: node.perkId, major: type === "MAJOR", path });
    }
    return out.sort((a, b) => a.path.length - b.path.length);
  }, [graph, allocated, majorOnly, maxPoints]);

  const apply = useCallback(
    (candidate: Candidate) => candidateFor(doc, tree, "allocate", candidate.path)!,
    [doc, tree],
  );
  const keyOf = useCallback((candidate: Candidate) => candidate.key, []);
  const ranking = useRanking({ candidates, apply, keyOf });

  // The sheet stats worth offering are the ones some candidate actually moved; a select holding
  // all six hundred of the pack's stat ids would be a haystack.
  const statMetrics = useMemo<Metric[]>(() => {
    const seen = new Map<string, string>();
    for (const row of ranking.rows) {
      for (const delta of row.comparison.stats) {
        if (!seen.has(delta.key)) seen.set(delta.key, delta.label);
      }
    }
    return [...seen]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, label]) => ({
        id: STAT_PREFIX + id,
        label,
        of: (v: Vitals) => v.stats.get(id) ?? 0,
      }));
  }, [ranking.rows]);

  const metric =
    HEADLINE_METRICS.find((m) => m.id === metricId) ??
    statMetrics.find((m) => m.id === metricId) ??
    HEADLINE_METRICS[0]!;

  const rows = useMemo(() => {
    const baseValue = metric.of(ranking.base);
    const scored = ranking.rows.map((row) => {
      const gain = metric.of(row.vitals) - baseValue;
      const points = row.candidate.path.length;
      return { row, gain, points, perPoint: gain / points, baseValue };
    });
    const by: Record<SortBy, (a: Scored, b: Scored) => number> = {
      perPoint: (a, b) => b.perPoint - a.perPoint,
      gain: (a, b) => b.gain - a.gain,
      points: (a, b) => a.points - b.points || b.gain - a.gain,
    };
    return scored.sort(by[sortBy]);
  }, [ranking.rows, ranking.base, metric, sortBy]);

  return (
    <div className="node-rank">
      <div className="node-rank-controls row gap-4">
        <label className="row gap-3">
          <span className="faint">Rank by</span>
          <select value={metric.id} onChange={(event) => setMetricId(event.target.value)}>
            {HEADLINE_METRICS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            {statMetrics.length > 0 && (
              <optgroup label="Stats these nodes move">
                {statMetrics.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <label className="row gap-3">
          <span className="faint">Sort</span>
          <select value={sortBy} onChange={(event) => setSortBy(event.target.value as SortBy)}>
            <option value="perPoint">Gain per point</option>
            <option value="gain">Total gain</option>
            <option value="points">Fewest points</option>
          </select>
        </label>
        <label className="row gap-3">
          <span className="faint">Within</span>
          <select
            value={maxPoints ?? ""}
            onChange={(event) =>
              setMaxPoints(event.target.value === "" ? undefined : Number(event.target.value))
            }
          >
            {MAX_POINTS.map((n) => (
              <option key={n ?? "any"} value={n ?? ""}>
                {n === undefined ? "any distance" : `${n} points`}
              </option>
            ))}
          </select>
        </label>
        <label className="row gap-3">
          <input type="checkbox" checked={majorOnly} onChange={(e) => setMajorOnly(e.target.checked)} />
          <span>Gamechangers only</span>
        </label>
        <span className="faint text-sm">
          {ranking.pending
            ? `pricing ${ranking.done} of ${ranking.total}…`
            : `${ranking.total} priced`}
        </span>
      </div>

      <div className="node-rank-row node-rank-head faint text-sm">
        <span>Node</span>
        <span>Points</span>
        <span>{metric.label}</span>
        <span>Per point</span>
        <span />
      </div>
      {rows.length === 0 && (
        <div className="faint text-sm node-rank-empty">
          {ranking.pending
            ? "Pricing the nearest nodes first…"
            : candidates.length === 0
              ? "Nothing reachable matches these filters."
              : "No results."}
        </div>
      )}
      <div
        className="node-rank-rows"
        onMouseLeave={() => onPreview(undefined)}
      >
        {rows.map(({ row, gain, points, perPoint, baseValue }) => {
          const nothing = Math.abs(gain) <= NOISE;
          const tone = nothing ? "faint" : gain > 0 ? "up" : "down";
          return (
            <div
              key={row.id}
              className="node-rank-row"
              onMouseEnter={() => onPreview(new Set(row.candidate.path))}
              onClick={() => onFocus(row.candidate.key)}
              title="Click to find it on the tree"
            >
              <span className="ellipsis">
                {row.candidate.major && <span className="badge warn node-rank-gc">GC</span>}
                {perkName(world.snapshot, row.candidate.perkId)}
              </span>
              <span className="num">{points}</span>
              <span className={`num ${tone}`}>
                {nothing ? (
                  "—"
                ) : (
                  <>
                    {signGlyph(gain)}
                    {smart(round(Math.abs(gain)))}
                    {baseValue > 0 && <span className="faint"> {percent(gain / baseValue)}</span>}
                  </>
                )}
              </span>
              <span className={`num ${tone}`}>
                {nothing ? "—" : `${signGlyph(perPoint)}${smart(round(Math.abs(perPoint)))}`}
              </span>
              <button
                className="node-rank-take"
                onClick={(event) => {
                  event.stopPropagation();
                  onPreview(undefined);
                  allocateNodes(tree, row.candidate.path);
                }}
                title={`Allocate this node and the ${points - 1} on the way`}
              >
                Take
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type Scored = {
  row: Ranked<Candidate>;
  gain: number;
  points: number;
  perPoint: number;
  baseValue: number;
};
