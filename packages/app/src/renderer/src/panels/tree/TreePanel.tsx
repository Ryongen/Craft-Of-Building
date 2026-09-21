/**
 * The three trees, their point budgets, and search.
 *
 * Point accounting is read from `mmorpg_game_balance.player_points` through `pointBudget`, not
 * counted by hand: `fromLevel` is what levelling gives, and `ceiling` adds the bonus points a
 * document cannot see. Spending past `fromLevel` is suspicious rather than impossible, which
 * is exactly how the validator grades it — and why a click is never refused for want of
 * points, unlike in game.
 *
 * Everything else about allocation *is* the game's rule set, via `treeGraph` and the
 * `TalentsData` port in `@cte2/schema`.
 */

import {
  modifierLine,
  nodeKey,
  parseNodeKey,
  perkName,
  pointsAvailable,
  TREE_POINT_TYPE,
  TREE_KEYS,
  type BuildDoc,
  type NodeKey,
  type TreeCoord,
  type TreeKey,
} from "@cte2/schema";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { Snapshot } from "@cte2/extractor";
import { balance, parseSourceMod, sourceToExact, statIndex } from "@cte2/engine";

import { useBuild } from "../../state/build-store.js";
import { useWhatIf } from "../../state/compare.js";
import { useWorld } from "../../state/snapshot.js";
import { ComparisonBlock } from "../../ui/DeltaTable.js";
import { SearchInput } from "../../ui/SearchInput.js";

import { StatPoints } from "../character/StatPoints.js";
import { perkData, TreeCanvas, type HoverInfo } from "./TreeCanvas.js";

const TREES: { key: TreeKey; label: string }[] = [
  { key: "talents", label: "Talents" },
  { key: "ascendancy", label: "Ascendancy" },
  { key: "atlas", label: "Atlas" },
];

/** `one_kind` of the sixteen ascendancy entry perks, which is also `character.ascendancy`. */
const ASCENDANCY_KIND = "ascendancy";

export function TreePanel(): ReactNode {
  const world = useWorld();
  const doc = useBuild((s) => s.doc);
  const allocateNodes = useBuild((s) => s.allocateNodes);
  const deallocateNodes = useBuild((s) => s.deallocateNodes);
  const clearTree = useBuild((s) => s.clearTree);
  const setAscendancy = useBuild((s) => s.setAscendancy);

  const [tree, setTree] = useState<TreeKey>("talents");
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const graph = world.graph(tree);
  const coords = doc.tree?.[tree] ?? [];

  const allocated = useMemo<ReadonlySet<NodeKey>>(
    () => new Set(coords.map(([row, col]) => `${row},${col}`)),
    [coords],
  );

  // The ascendancy is a document field *and* an allocated entry perk. Keep them in step from
  // the tree, since the tree is where the choice is actually made.
  const chosenAscendancy = useMemo(() => {
    const ascGraph = world.graph("ascendancy");
    if (ascGraph === undefined) return undefined;
    for (const [row, col] of doc.tree?.ascendancy ?? []) {
      const node = ascGraph.nodes.get(`${row},${col}`);
      if (node?.perk?.oneKind === ASCENDANCY_KIND) return node.perkId;
    }
    return undefined;
  }, [doc.tree?.ascendancy, world]);

  useEffect(() => {
    if (doc.character.ascendancy !== chosenAscendancy) setAscendancy(chosenAscendancy);
  }, [chosenAscendancy, doc.character.ascendancy, setAscendancy]);

  // Search matches on the perk's name and on the stats it grants, because "find me every node
  // that gives crit damage" is the question a build actually asks.
  const highlighted = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const out = new Set<string>();
    if (needle.length === 0 || graph === undefined) return out;

    for (const [perkId, registryEntry] of Object.entries(
      world.snapshot.registries["mmorpg_perk"] ?? {},
    )) {
      if (perkId.toLowerCase().includes(needle)) {
        out.add(perkId);
        continue;
      }
      if (perkName(world.snapshot, perkId).toLowerCase().includes(needle)) {
        out.add(perkId);
        continue;
      }
      const stats = registryEntry.data["stats"];
      if (!Array.isArray(stats)) continue;
      for (const mod of stats) {
        if (mod === null || typeof mod !== "object") continue;
        const statId = (mod as Record<string, unknown>)["stat"];
        if (typeof statId === "string" && statId.toLowerCase().includes(needle)) {
          out.add(perkId);
          break;
        }
        const line = modifierLine(world.snapshot, mod as Record<string, unknown>);
        if (line.toLowerCase().includes(needle)) {
          out.add(perkId);
          break;
        }
      }
    }
    return out;
  }, [query, graph, world.snapshot]);

  // `character.pointTotals` wins where a capture recorded it: `getFreePoints` includes the
  // quest and item bonus points, which is the difference between "126 of 101, needs bonus
  // points" and the legal allocation the game had just reported.
  const points = pointsAvailable(world.snapshot, doc.character, TREE_POINT_TYPE[tree]);
  const budget = points.budget;

  if (graph === undefined) {
    return (
      <div className="panel">
        <div className="notice">
          This snapshot has no <code>{TREE_KEYS[tree]}</code> tree.
        </div>
      </div>
    );
  }

  const spent = coords.length;
  // What the denominator should say. A capture's `pointTotals` is the character's real count and
  // wins; without one, a *planner* wants the whole obtainable pool rather than the levelling
  // share, because 126 talents and 9 ascendancy points are what a level 100 character in this
  // pack has — showing "/ 101" and "/ 0" made the two trees look unspendable. Nothing is gated on
  // this either way: allocation was never capped, and the badges below still name the band.
  const available = points.recorded ? points.total : (budget?.ceiling ?? points.total);
  const overLevel = !points.recorded && budget !== undefined && spent > budget.fromLevel;
  const overCeiling = spent > (points.recorded ? points.total : (budget?.ceiling ?? Infinity));
  const needsStart = ![...allocated].some((key) => graph.nodes.get(key)?.perk?.isEntry === true);
  const startNames = [...new Set(graph.entries.map((e) => perkName(world.snapshot, e.perkId)))];

  return (
    <div style={{ position: "relative", minHeight: 0, display: "grid" }}>
      <TreeCanvas
        graph={graph}
        allocated={allocated}
        highlighted={highlighted}
        onAllocate={(keys) => allocateNodes(tree, keys)}
        onDeallocate={(keys) => deallocateNodes(tree, keys)}
        onHover={setHover}
      />

      <div className="tree-overlay">
        {/*
          The tree buttons, and the level-up points under them.

          `.tree-overlay` is a flex row, so a second block added to it lands *beside* the
          buttons; the column here is what puts it underneath. Stat points had a tab to
          themselves, which was three rows and a paragraph two clicks from the only other place
          points are spent — and nobody spends stat points in a session where they are not also
          spending tree points.
        */}
        <div className="tree-hud-column">
          <div className="tree-hud row gap-5">
            {TREES.map((option) => (
              <button
                key={option.key}
                className={tree === option.key ? "primary" : ""}
                onClick={() => setTree(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="tree-hud">
            <div className="section-title mt-0">Stat points</div>
            <StatPoints compact />
          </div>
        </div>

        <div className="tree-hud row gap-5">
          <span className="num">
            {spent}
            {(points.recorded || budget !== undefined) && (
              <span
                className="faint"
                title={
                  points.recorded
                    ? "What the game reported for this character, bonus points included"
                    : `Everything obtainable at level ${doc.character.level}: ${budget?.fromLevel} from ` +
                      `levelling plus ${budget?.maxBonus} from quests and items. Past the levelling ` +
                      `share it says "needs bonus points" rather than stopping you.`
                }
              >
                {" "}/ {available}
              </span>
            )}
          </span>
          <span className="faint">points</span>
          {overCeiling ? (
            <span className="badge bad" title={points.recorded ? `The game reported ${points.total} for this character` : `Ceiling at this level is ${budget?.ceiling}`}>
              over ceiling
            </span>
          ) : overLevel ? (
            <span className="badge warn" title="Possible only with bonus points from quests or items">
              needs bonus points
            </span>
          ) : null}
          <button onClick={() => clearTree(tree)} disabled={spent === 0}>
            Clear
          </button>
        </div>

        <SearchInput
          placeholder="Find a node by name or stat…"
          value={query}
          onChange={setQuery}
          width={240}
        />
        {query.trim().length > 0 && (
          <div className="tree-hud faint">{highlighted.size} matching perks</div>
        )}

        <div className="grow" />

        {needsStart ? (
          <div className="tree-hud text-sm" style={{ maxWidth: 320 }}>
            <strong>Pick a start.</strong>{" "}
            <span className="faint">
              Nothing else can be taken until one is allocated. {startNames.length} to choose from
              {startNames.length <= 8 ? `: ${startNames.join(", ")}` : ""}.
            </span>
          </div>
        ) : (
          <div className="tree-hud faint text-sm" style={{ maxWidth: 320 }}>
            Click any reachable node to buy the shortest path to it. Clicking an allocated node
            gives back everything it was holding up.
          </div>
        )}
      </div>

      {hover !== null && <PerkTooltip hover={hover} tree={tree} />}
    </div>
  );
}

/**
 * The document that results from adding or removing exactly `keys`.
 *
 * Called twice per hover, with two different sets. The **click's** set is `hover.affected`:
 * taking a distant node buys the cheapest route to it, and refunding one gives back the branch
 * it was holding up, so that is what the button actually does and what makes the figure honest
 * about cost — six points of pathing to reach a good node is six points of stats.
 *
 * The **node's own** set is the single node under the cursor. That is not a click the tree would
 * ever offer, which is the point: it separates "what is this node contributing" from "what does
 * pressing this cost me", and on the reference build those differ by a factor of seventy.
 */
function candidateFor(
  doc: BuildDoc,
  tree: TreeKey,
  action: HoverInfo["action"],
  keys: readonly NodeKey[],
): BuildDoc | undefined {
  if (action === "blocked" || keys.length === 0) return undefined;

  const current = doc.tree?.[tree] ?? [];
  let next: TreeCoord[];
  if (action === "allocate") {
    const held = new Set(current.map(([r, c]) => nodeKey(r, c)));
    next = [...current, ...keys.filter((k) => !held.has(k)).map(parseNodeKey)];
  } else {
    const drop = new Set(keys);
    next = current.filter(([r, c]) => !drop.has(nodeKey(r, c)));
  }

  const nextTree = { ...(doc.tree ?? {}) };
  if (next.length === 0) delete nextTree[tree];
  else nextTree[tree] = next;
  return { ...doc, tree: nextTree };
}

/**
 * A perk's stat lines, at the character's level.
 *
 * Perk stats are the `{ type, stat, v1, scale_to_lvl }` shape, and 40 of this pack's 1,497 set
 * `scale_to_lvl` — the flats the game grows with the holder, which is `energy_on_hit`,
 * `health_regen`, `accuracy`, `blood_on_kill` and the rest of what a player reads as "scales
 * with level". `modifierLine` is documented as the *un-levelled* preview, so the tooltip
 * printed `energy_regen_percent_big` as "+2 Energy Regen" against the much larger number the
 * same node had just put on the sheet.
 *
 * `sourceToExact` is the call `collectPerks` makes, so the line and the delta underneath it
 * come from one number rather than two.
 */
function perkLines(snapshot: Snapshot, perkId: string, level: number): string[] {
  const raw = perkData(snapshot, perkId)?.["stats"];
  if (!Array.isArray(raw)) return [];
  const index = statIndex(snapshot);
  const curves = balance(snapshot);

  return raw
    .filter(
      (s): s is Record<string, unknown> => s !== null && typeof s === "object" && !Array.isArray(s),
    )
    .map((mod) => {
      const source = parseSourceMod(mod);
      if (source === undefined) return modifierLine(snapshot, mod);
      const exact = sourceToExact(source, level, index.shapeOf(source.statId), curves);
      // `modifierLine` words the stat; feeding the resolved value back as a fixed `v1` keeps
      // the wording — templates, "More"/"Increased", the percent suffix — and swaps the number.
      return modifierLine(snapshot, { stat: exact.statId, type: exact.type, v1: exact.value });
    });
}

function PerkTooltip({ hover, tree }: { hover: HoverInfo; tree: TreeKey }): ReactNode {
  const world = useWorld();
  const doc = useBuild((s) => s.doc);
  const data = perkData(world.snapshot, hover.perkId);
  const level = doc.character.level;
  const lines = useMemo(
    () => perkLines(world.snapshot, hover.perkId, level),
    [world.snapshot, hover.perkId, level],
  );
  const type = typeof data?.["type"] === "string" ? (data["type"] as string) : undefined;
  const oneKind = typeof data?.["one_kind"] === "string" ? (data["one_kind"] as string) : undefined;
  const maxLevels = typeof data?.["max_lvls"] === "number" ? (data["max_lvls"] as number) : 1;
  const isEntry = data?.["is_entry"] === true;

  // Keyed on the node and the action, so the candidates are new objects only when the cursor
  // moves to a different node — `useWhatIf` restarts its timer on identity.
  //
  // The cursor's x and y are on `hover` and change every mouse-move; the node under it does not,
  // and it is the node this is about.
  /* eslint-disable react-hooks/exhaustive-deps */
  const candidate = useMemo(
    () => candidateFor(doc, tree, hover.action, hover.affected),
    [doc, tree, hover.key, hover.action, hover.affected.length],
  );
  // Only worth a second figure when the click moves more than the node itself. A leaf node is
  // its own whole click, and showing the same numbers twice would be noise.
  const cascades = hover.affected.length > 1;
  const alone = useMemo(
    () => (cascades ? candidateFor(doc, tree, hover.action, [hover.key]) : undefined),
    [doc, tree, hover.key, hover.action, cascades],
  );
  /* eslint-enable react-hooks/exhaustive-deps */
  const whatIf = useWhatIf(candidate, alone);

  const others = hover.affected.length - 1;
  const clickLabel =
    hover.action === "allocate"
      ? cascades
        ? `Taking it, and the ${others} on the way`
        : "Taking this"
      : cascades
        ? `Refunding it, and the ${others} it holds up`
        : "Refunding this";

  // Flip to the other side of the cursor near the right or bottom edge.
  const flipX = hover.x > window.innerWidth - 700;
  const flipY = hover.y > window.innerHeight - 380;

  return (
    <div
      className={`tree-tooltip${candidate === undefined ? "" : " with-delta"}`}
      style={{
        left: flipX ? undefined : hover.x + 16,
        right: flipX ? 16 : undefined,
        top: flipY ? undefined : hover.y + 16,
        bottom: flipY ? 16 : undefined,
      }}
    >
      <div className="tt-name">{perkName(world.snapshot, hover.perkId)}</div>
      <div className="row gap-3" style={{ marginBottom: 5 }}>
        {type !== undefined && <span className="badge">{type}</span>}
        {isEntry && <span className="badge">entry</span>}
        <span className="badge mono">{hover.perkId}</span>
      </div>
      {lines.length === 0 && <div className="faint">Grants no stats.</div>}
      {lines.map((line, index) => (
        <div key={index} className="tt-line">
          {line}
        </div>
      ))}
      {/* The game prints the same caution on its own tooltip (`Perk.java:135-139`). */}
      {oneKind !== undefined && (
        <div className="tt-line" style={{ marginTop: 5 }}>
          Only one perk of kind <code>{oneKind}</code> may be allocated.
        </div>
      )}
      {maxLevels > 1 && <div className="faint">Up to {maxLevels} levels in game.</div>}

      <div className="mt-3 text-sm">
        {hover.action === "allocate" && (
          <span>
            Click to allocate <strong>{hover.affected.length}</strong>{" "}
            {hover.affected.length === 1 ? "point" : "points"}.
          </span>
        )}
        {hover.action === "deallocate" && (
          <span>
            Click to refund <strong>{hover.affected.length}</strong>{" "}
            {hover.affected.length === 1 ? "point" : "points"}
            {hover.affected.length > 1 && " — this node is holding up the rest"}.
          </span>
        )}
        {hover.action === "blocked" && <span className="faint">No legal route to this node.</span>}
      </div>

      {candidate !== undefined && (
        <div className="delta-section">
          {/* The click leads, because it is what the button under the cursor does and the one
              figure that is always true. The node's own share follows as context — headline
              figures only, since the perk's stats are printed in full at the top of this same
              tooltip and a second sixty-row list would push the click off the screen. */}
          <div className="delta-section-title">
            {clickLabel}
            {whatIf === undefined && " · measuring…"}
          </div>
          {whatIf === undefined ? (
            // A held row rather than a collapsing one: the tooltip would otherwise jump a
            // hundred pixels the instant the numbers land, under a cursor that has not moved.
            <div className="faint text-sm" style={{ minHeight: 34 }}>
              Recomputing the build with this change…
            </div>
          ) : (
            <ComparisonBlock
              comparison={whatIf.click.comparison}
              emptyNote={
                hover.action === "allocate"
                  ? "Moves no number this planner reports."
                  : "Costs no number this planner reports."
              }
            />
          )}

          {cascades && (
            <>
              <div className="delta-section-title mt-4">
                Of which this node alone
              </div>
              {whatIf?.alone === undefined ? (
                <div className="faint text-sm" style={{ minHeight: 20 }} />
              ) : (
                <>
                  <ComparisonBlock
                    comparison={whatIf.alone.comparison}
                    stats={false}
                    emptyNote="No headline figure moves for this node by itself — what it grants is the lines above."
                  />
                  <div className="faint text-sm" style={{ marginTop: 3 }}>
                    {hover.action === "allocate"
                      ? `The node on its own, with the ${others} on the way already paid for`
                      : `The node on its own, with the ${others} hanging off it left where they are`}{" "}
                    — not a click the tree offers, which is why the figure above is the one to
                    judge it by.
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      <div className="faint text-sm" style={{ marginTop: 5 }}>
        row {hover.row}, col {hover.col}
      </div>
    </div>
  );
}
