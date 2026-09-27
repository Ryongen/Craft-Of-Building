/**
 * The talent tree as a graph, and the allocation rules that run on it.
 *
 * Ported from mahjerion/Mine-And-Slash-Rework @ `1.20-Forge`:
 * `database/data/talent_tree/parser/{TalentGrid,GridPoint}.java` builds the edges, and
 * `saveclasses/perks/TalentsData.java` decides what may be allocated and removed. Both are
 * quoted at their call sites below.
 *
 * The headline correction over what this project previously assumed: **the edges are not an
 * inference.** A connector glyph is a *channel id*, not a line direction — a path between two
 * talents may only traverse connector cells that all bear the same letter. `o` and `k` are two
 * independent wires that cross on the grid without connecting. That single rule is the whole
 * difference between the real tree and a plausible-looking one.
 *
 * The second correction: `[CENTER]` is **not** the allocation anchor. It exists so the tree
 * screen knows where to put the camera (`SkillTreeScreen.getPosForPoint`) and for a
 * `requireNonNull` at load. Allocations must reach an `is_entry` perk — one of the six class
 * starts, or one of the sixteen ascendancies.
 */

import type { Snapshot } from "@cte2/extractor";

import type { TreeCoord } from "./build-doc.js";
import { type PerkView, type TreeGrid, perk, treeGrid } from "./queries.js";

/**
 * `GridPoint.MAX_DISTANCE`. Two talents further apart than this on *either* axis are never
 * connected even when a wire runs between them — the game filters the pair before searching
 * (`isInDistanceOf`, an exclusive `< 12` on both `|dx|` and `|dy|`).
 */
const MAX_DISTANCE = 12;

/** `[row, col]` packed into a string, so nodes and edges can key a `Map`/`Set`. */
export type NodeKey = string;

export function nodeKey(row: number, col: number): NodeKey {
  return `${row},${col}`;
}

export function parseNodeKey(key: NodeKey): TreeCoord {
  const comma = key.indexOf(",");
  return [Number(key.slice(0, comma)), Number(key.slice(comma + 1))];
}

export type TreeNode = {
  key: NodeKey;
  row: number;
  col: number;
  perkId: string;
  /** `undefined` when the grid names a perk the registry does not have. */
  perk: PerkView | undefined;
};

export type TreeEdge = {
  a: NodeKey;
  b: NodeKey;
  /** The connector channel this edge runs on. */
  glyph: string;
  /**
   * The connector cells the search walked through, `a`-end first. The renderer draws the wire
   * along these rather than a straight line, which is what the grid art actually depicts.
   */
  path: readonly TreeCoord[];
};

export type TreeGraph = {
  id: string;
  grid: TreeGrid;
  /** Every talent cell, keyed by `nodeKey`. */
  nodes: ReadonlyMap<NodeKey, TreeNode>;
  edges: readonly TreeEdge[];
  neighbours(key: NodeKey): readonly NodeKey[];
  /** Nodes whose perk is `is_entry` — the only ones allocatable from nothing. */
  entries: readonly TreeNode[];
};

const GRAPH_CACHE = new WeakMap<Snapshot, Map<string, TreeGraph | undefined>>();

export function treeGraph(snapshot: Snapshot, treeId: string): TreeGraph | undefined {
  let byId = GRAPH_CACHE.get(snapshot);
  if (!byId) {
    byId = new Map();
    GRAPH_CACHE.set(snapshot, byId);
  }
  if (byId.has(treeId)) return byId.get(treeId);

  const built = buildTreeGraph(snapshot, treeId);
  byId.set(treeId, built);
  return built;
}

/** The eight neighbour offsets, as `[dRow, dCol]`. */
const DIRS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

function buildTreeGraph(snapshot: Snapshot, treeId: string): TreeGraph | undefined {
  const grid = treeGrid(snapshot, treeId);
  if (!grid) return undefined;

  const isTalent = (row: number, col: number): boolean => grid.cellAt(row, col)?.kind === "perk";
  const glyphAt = (row: number, col: number): string | undefined => {
    const cell = grid.cellAt(row, col);
    return cell?.kind === "connector" ? cell.glyph : undefined;
  };

  const nodes = new Map<NodeKey, TreeNode>();
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const cell = grid.cellAt(row, col);
      if (cell?.kind !== "perk" || cell.perkId === undefined) continue;
      const key = nodeKey(row, col);
      nodes.set(key, { key, row, col, perkId: cell.perkId, perk: perk(snapshot, cell.perkId) });
    }
  }

  /**
   * `TalentGrid.getEligibleSurroundingPoints` (`:129-162`).
   *
   *     if (Math.abs(dx) == 1 && Math.abs(dy) == 1) { // we are discovering a diagonal
   *         if (get(x + dx, y).isTalent || get(x, y + dy).isTalent) {
   *             continue; // skip this diagonal, it crosses a talent
   *         }
   *     }
   *     if (point.isTalent) { set.add(point); }
   *     else if (point.isConnector) { if (point.getId().equals(connector)) { set.add(point); } }
   *
   * A talent is always admitted; a connector only when its glyph is the channel being walked.
   * Anything else — empty, `[CENTER]`, a two-character token — is a wall. Note the Java's `x`
   * is the column and `y` the row, so its `get(x + dx, y)` is the horizontal neighbour.
   */
  const eligible = (row: number, col: number, channel: string): TreeCoord[] => {
    const out: TreeCoord[] = [];
    for (const [dRow, dCol] of DIRS) {
      const r = row + dRow;
      const c = col + dCol;
      if (dRow !== 0 && dCol !== 0 && (isTalent(row, col + dCol) || isTalent(row + dRow, col))) {
        continue; // the diagonal cuts the corner past a talent
      }
      if (isTalent(r, c) || glyphAt(r, c) === channel) out.push([r, c]);
    }
    return out;
  };

  /** `TalentGrid.getConnectorTypes` (`:114-127`) — the channels leaving this talent. */
  const channelsAt = (row: number, col: number): string[] => {
    const set = new Set<string>();
    for (const [dRow, dCol] of DIRS) {
      const glyph = glyphAt(row + dRow, col + dCol);
      if (glyph !== undefined) set.add(glyph);
    }
    return [...set];
  };

  /**
   * `TalentGrid.hasPath` (`:84-112`), inverted.
   *
   * The game asks "is `two` reachable from `one`" once per candidate pair, which is a BFS per
   * pair per channel over 1,321 talents. Because the search terminates at every talent it
   * reaches, one BFS from `one` already names *every* talent connected to it on that channel —
   * so we run it once per (node, channel) and read the answers off, which is the same set for a
   * fraction of the work.
   *
   * Termination matches the Java exactly: a talent that is not the start is recorded and then
   * not expanded, so a path never runs *through* an intermediate talent.
   */
  const reachFrom = (start: TreeNode, channel: string): Map<NodeKey, TreeCoord[]> => {
    const found = new Map<NodeKey, TreeCoord[]>();
    const seen = new Set<NodeKey>([start.key]);
    // Each queue entry carries the connector cells walked to get there, for the renderer.
    const queue: { row: number; col: number; path: TreeCoord[] }[] = [
      { row: start.row, col: start.col, path: [] },
    ];

    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]!;

      for (const [r, c] of eligible(current.row, current.col, channel)) {
        const key = nodeKey(r, c);
        if (seen.has(key)) continue;
        seen.add(key);

        if (isTalent(r, c)) {
          found.set(key, current.path); // record it, but never search through it
          continue;
        }
        queue.push({ row: r, col: c, path: [...current.path, [r, c] as TreeCoord] });
      }
    }
    return found;
  };

  const edges: TreeEdge[] = [];
  const adjacency = new Map<NodeKey, Set<NodeKey>>();
  const seenPair = new Set<string>();

  for (const node of nodes.values()) {
    for (const channel of channelsAt(node.row, node.col)) {
      for (const [otherKey, path] of reachFrom(node, channel)) {
        const other = nodes.get(otherKey);
        if (!other) continue;
        // `isInDistanceOf` — applied to the *pair*, not to the path length.
        if (
          Math.abs(node.row - other.row) >= MAX_DISTANCE ||
          Math.abs(node.col - other.col) >= MAX_DISTANCE
        ) {
          continue;
        }
        const pair = node.key < otherKey ? `${node.key}|${otherKey}` : `${otherKey}|${node.key}`;
        if (seenPair.has(pair)) continue;
        seenPair.add(pair);

        edges.push({ a: node.key, b: otherKey, glyph: channel, path });
        linkOf(adjacency, node.key).add(otherKey);
        linkOf(adjacency, otherKey).add(node.key);
      }
    }
  }

  const neighbourLists = new Map<NodeKey, NodeKey[]>();
  for (const [key, set] of adjacency) neighbourLists.set(key, [...set]);

  return {
    id: treeId,
    grid,
    nodes,
    edges,
    neighbours: (key) => neighbourLists.get(key) ?? [],
    entries: [...nodes.values()].filter((n) => n.perk?.isEntry === true),
  };
}

function linkOf(map: Map<NodeKey, Set<NodeKey>>, key: NodeKey): Set<NodeKey> {
  let set = map.get(key);
  if (!set) {
    set = new Set<NodeKey>();
    map.set(key, set);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Allocation rules — TalentsData.java
// ---------------------------------------------------------------------------

export type AllocationBlock =
  | { reason: "unknown-node" }
  | { reason: "not-connected" }
  | { reason: "one-kind"; oneKind: string; heldBy: string };

/**
 * `TalentsData.canAllocate` (`:56-81`), minus the free-points check.
 *
 *     if (!perk.is_entry) {
 *         Set<PointData> con = school.calcData.connections.get(point);
 *         if (con == null || !con.stream().anyMatch(x -> ...isAllocated(x))) { return false; }
 *     }
 *     if (perk.one_kind != null && !perk.one_kind.isEmpty()) {
 *         if (getAllAllocatedPerks(...).values().stream()
 *               .anyMatch(x -> x.one_kind != null && x.one_kind.equals(perk.one_kind))) { return false; }
 *     }
 *
 * Free points are deliberately not part of this. Bonus points come from quests and items that a
 * build document cannot see, and `ASCENDANCY`/`ATLAS` grant *zero* points from levelling, so
 * gating clicks on the budget would make two of the three trees unusable. The validator grades
 * the budget separately, as a warning.
 */
export function allocationBlock(
  graph: TreeGraph,
  allocated: ReadonlySet<NodeKey>,
  key: NodeKey,
): AllocationBlock | undefined {
  const node = graph.nodes.get(key);
  if (!node) return { reason: "unknown-node" };

  if (node.perk?.isEntry !== true) {
    const connected = graph.neighbours(key).some((n) => allocated.has(n));
    if (!connected) return { reason: "not-connected" };
  }

  const oneKind = node.perk?.oneKind;
  if (oneKind !== undefined) {
    for (const held of allocated) {
      if (held === key) continue;
      const other = graph.nodes.get(held);
      if (other?.perk?.oneKind === oneKind) {
        return { reason: "one-kind", oneKind, heldBy: other.perkId };
      }
    }
  }
  return undefined;
}

export function canAllocate(
  graph: TreeGraph,
  allocated: ReadonlySet<NodeKey>,
  key: NodeKey,
): boolean {
  return allocationBlock(graph, allocated, key) === undefined;
}

/**
 * Whether `from` still reaches an `is_entry` perk through allocated nodes once `toRemove` is
 * gone — `TalentsData.hasPathToStart` (`:107-137`).
 */
export function hasPathToEntry(
  graph: TreeGraph,
  allocated: ReadonlySet<NodeKey>,
  from: NodeKey,
  toRemove?: NodeKey,
): boolean {
  const seen = new Set<NodeKey>();
  const queue: NodeKey[] = [from];

  for (let head = 0; head < queue.length; head++) {
    const key = queue[head]!;
    if (key === toRemove || !allocated.has(key)) continue;
    if (graph.nodes.get(key)?.perk?.isEntry === true) return true;
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(...graph.neighbours(key));
  }
  return false;
}

/**
 * Every allocated node that would be cut adrift by removing `key`, `key` included.
 *
 * The game simply refuses a removal that would orphan anything (`canRemove`). A planner is more
 * useful if it removes the branch instead and shows you what it is about to take, which is what
 * `cte2-planner` does — so this returns the set rather than a boolean. The invariant it is
 * derived from is the game's.
 */
export function orphansIfRemoved(
  graph: TreeGraph,
  allocated: ReadonlySet<NodeKey>,
  key: NodeKey,
): Set<NodeKey> {
  const removed = new Set<NodeKey>([key]);
  if (!allocated.has(key)) return removed;

  // Everything still reaching an entry through the surviving set stays. One pass is enough:
  // the flood is recomputed from scratch against `removed`, so a node orphaned two hops back
  // simply never gets reached.
  const survivors = new Set<NodeKey>();
  const queue: NodeKey[] = [];
  for (const held of allocated) {
    if (removed.has(held)) continue;
    if (graph.nodes.get(held)?.perk?.isEntry === true) {
      survivors.add(held);
      queue.push(held);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    for (const n of graph.neighbours(queue[head]!)) {
      if (removed.has(n) || survivors.has(n) || !allocated.has(n)) continue;
      survivors.add(n);
      queue.push(n);
    }
  }

  for (const held of allocated) {
    if (!survivors.has(held)) removed.add(held);
  }
  return removed;
}

/**
 * The cheapest route from the allocated set to `target`, as the nodes that would have to be
 * newly allocated (target last). `undefined` when no legal route exists, `[]` when `target` is
 * already allocated.
 *
 * This is the behaviour `cte2-planner` calls "find the shortest path between selected talents",
 * reimplemented against the graph the mod's own parser defines rather than taken from that
 * project — it is GPL-3.0 and this repository is MIT.
 *
 * When nothing is allocated yet the only legal targets are entry perks, which falls out of the
 * rules rather than being special-cased: the search seeds from the entry nodes themselves.
 */
export function shortestPathTo(
  graph: TreeGraph,
  allocated: ReadonlySet<NodeKey>,
  target: NodeKey,
): NodeKey[] | undefined {
  if (allocated.has(target)) return [];
  if (!graph.nodes.has(target)) return undefined;

  // Adjacency is guaranteed by the search itself, so only `one_kind` can veto a step — and it
  // vetoes against the *existing* set only, since a path never takes two perks of one kind.
  const heldKinds = new Set<string>();
  for (const key of allocated) {
    const kind = graph.nodes.get(key)?.perk?.oneKind;
    if (kind !== undefined) heldKinds.add(kind);
  }
  const walkable = (key: NodeKey): boolean => {
    if (allocated.has(key)) return true;
    const kind = graph.nodes.get(key)?.perk?.oneKind;
    return kind === undefined || !heldKinds.has(kind);
  };
  if (!walkable(target)) return undefined;

  const cameFrom = new Map<NodeKey, NodeKey | undefined>();
  const queue: NodeKey[] = [];
  const seeds = allocated.size > 0 ? [...allocated] : graph.entries.map((e) => e.key);
  for (const seed of seeds) {
    if (!graph.nodes.has(seed) || cameFrom.has(seed)) continue;
    if (allocated.size === 0 && !walkable(seed)) continue;
    cameFrom.set(seed, undefined);
    queue.push(seed);
  }

  for (let head = 0; head < queue.length; head++) {
    const key = queue[head]!;
    if (key === target) return tracePath(cameFrom, key, allocated);
    for (const next of graph.neighbours(key)) {
      if (cameFrom.has(next) || !walkable(next)) continue;
      cameFrom.set(next, key);
      queue.push(next);
    }
  }
  return undefined;
}

export type Route = {
  /**
   * The nodes to newly allocate, in an order where each one touches the allocated set or an
   * earlier entry — so buying them front to back never makes an illegal click.
   */
  nodes: NodeKey[];
  /** Targets the route could not include: unreachable, or locked out by `one_kind`. */
  unreachable: NodeKey[];
};

/**
 * The cheapest set of nodes that allocates every one of `targets` — a Steiner tree over the
 * talent graph, with the allocated set as one terminal.
 *
 * Exact Steiner trees are NP-hard, but these graphs are small and nearly trees (degree ~2.3),
 * where a greedy "join the nearest target, repeat" is usually already optimal. Where it is not,
 * the usual failure is a cheap nearby target luring the route down a branch the others never
 * use, so the greedy runs once per target with that target forced first, and the smallest
 * result wins. Each run is `targets²` breadth-first searches over ~1,300 nodes: milliseconds.
 *
 * Every step goes through {@link shortestPathTo} against the growing set, so `one_kind` and the
 * must-reach-an-entry rule hold for the route exactly as they would for the clicks. When two
 * targets exclude each other the first one routed wins and the other lands in `unreachable`.
 *
 * With nothing allocated, each entry is tried as the start, and the chosen entry leads `nodes`.
 */
export function routeTo(
  graph: TreeGraph,
  allocated: ReadonlySet<NodeKey>,
  targets: readonly NodeKey[],
): Route {
  const wanted = [...new Set(targets)].filter((t) => !allocated.has(t));
  const missing = wanted.filter((t) => !graph.nodes.has(t));
  const routable = wanted.filter((t) => graph.nodes.has(t));
  if (routable.length === 0) return { nodes: [], unreachable: missing };

  const bases: { anchors: ReadonlySet<NodeKey>; fresh: NodeKey[] }[] =
    allocated.size > 0
      ? [{ anchors: allocated, fresh: [] }]
      : graph.entries.map((e) => ({ anchors: new Set([e.key]), fresh: [e.key] }));

  let best: Route | undefined;
  for (const base of bases) {
    if (routable.length <= EXACT_LIMIT) {
      best = better(best, exactRoute(graph, base.anchors, base.fresh, routable));
      continue;
    }
    for (const first of [undefined, ...routable]) {
      best = better(best, greedyRoute(graph, base.anchors, base.fresh, routable, first));
    }
  }
  if (best === undefined) return { nodes: [], unreachable: wanted };
  return { nodes: best.nodes, unreachable: [...missing, ...best.unreachable] };
}

/** More targets reached wins; then fewer points. */
function better(a: Route | undefined, b: Route): Route {
  if (a === undefined) return b;
  if (b.unreachable.length !== a.unreachable.length) {
    return b.unreachable.length < a.unreachable.length ? b : a;
  }
  return b.nodes.length < a.nodes.length ? b : a;
}

/**
 * Up to this many targets the route is solved exactly. Dreyfus–Wagner costs `3^k · n`; at eight
 * targets on the talent tree that is a few million steps, and it doubles-and-a-half per target.
 */
const EXACT_LIMIT = 8;

const UNREACHED = 1 << 28;

/**
 * The provably cheapest route, by Dreyfus–Wagner over the graph with `anchors` contracted into
 * one root vertex (it is already bought, so passing through it is free).
 *
 * `one_kind` is the one rule a subset DP cannot carry, since whether a node is walkable would
 * depend on which other nodes the tree holds. So it is resolved up front: a target whose kind is
 * already held, or claimed by an earlier target, is unreachable; and the route never passes
 * *through* a `one_kind` node that was not asked for — a singular-focus gamechanger is not
 * something to buy by accident on the way somewhere else.
 */
function exactRoute(
  graph: TreeGraph,
  anchors: ReadonlySet<NodeKey>,
  fresh: readonly NodeKey[],
  targets: readonly NodeKey[],
): Route {
  const claimed = new Set<string>();
  for (const key of anchors) {
    const kind = graph.nodes.get(key)?.perk?.oneKind;
    if (kind !== undefined) claimed.add(kind);
  }
  const unreachable: NodeKey[] = [];
  const terminals: NodeKey[] = [];
  for (const target of targets) {
    if (anchors.has(target)) continue;
    const kind = graph.nodes.get(target)?.perk?.oneKind;
    if (kind !== undefined && claimed.has(kind)) {
      unreachable.push(target);
      continue;
    }
    if (kind !== undefined) claimed.add(kind);
    terminals.push(target);
  }
  const terminalSet = new Set(terminals);

  // Index 0 is the contracted root; every other walkable node gets its own index.
  const keys: NodeKey[] = [""];
  const index = new Map<NodeKey, number>();
  for (const key of anchors) index.set(key, 0);
  for (const [key, node] of graph.nodes) {
    if (anchors.has(key)) continue;
    if (node.perk?.oneKind !== undefined && !terminalSet.has(key)) continue;
    index.set(key, keys.length);
    keys.push(key);
  }
  const n = keys.length;
  const adjacency: number[][] = Array.from({ length: n }, () => []);
  for (const [key, from] of index) {
    for (const next of graph.neighbours(key)) {
      const to = index.get(next);
      if (to !== undefined && to !== from) adjacency[from]!.push(to);
    }
  }

  // Terminals the root cannot reach at all drop out before the DP, which would otherwise carry
  // an infinite cost through every subset containing them.
  const rootDistance = bfs(adjacency, [0]);
  const reachable = terminals.filter((t) => rootDistance.cost[index.get(t)!]! < UNREACHED);
  unreachable.push(...terminals.filter((t) => !reachable.includes(t)));

  const k = reachable.length;
  const full = (1 << k) - 1;
  const cost: Int32Array[] = [];
  // How each (subset, vertex) state was reached: a parent vertex (`via >= 0`, a tree edge) or a
  // split into two smaller subsets (`via = -1 - subset`). The terminal leaf itself is `n`.
  const via: Int32Array[] = [];
  cost[0] = new Int32Array(n);
  via[0] = new Int32Array(n);

  for (let i = 0; i < k; i++) {
    const start = index.get(reachable[i]!)!;
    const found = bfs(adjacency, [start]);
    cost[1 << i] = found.cost;
    found.parent[start] = n;
    via[1 << i] = found.parent;
  }

  for (let set = 1; set <= full; set++) {
    if ((set & (set - 1)) === 0) continue;
    const here = new Int32Array(n).fill(UNREACHED);
    const how = new Int32Array(n).fill(n);
    const low = set & -set;
    for (let sub = (set - 1) & set; sub > 0; sub = (sub - 1) & set) {
      // Each split once: the half holding the lowest terminal is always `sub`.
      if ((sub & low) === 0) continue;
      const a = cost[sub]!;
      const b = cost[set ^ sub]!;
      for (let v = 0; v < n; v++) {
        const total = a[v]! + b[v]!;
        if (total < here[v]!) {
          here[v] = total;
          how[v] = -1 - sub;
        }
      }
    }
    relax(adjacency, here, how);
    cost[set] = here;
    via[set] = how;
  }

  if (k === 0) return { nodes: [...fresh], unreachable };

  const chosen = new Set<NodeKey>();
  const stack: [number, number][] = [[full, 0]];
  while (stack.length > 0) {
    const [set, v] = stack.pop()!;
    if (v !== 0) chosen.add(keys[v]!);
    const step = via[set]![v]!;
    if (step === n) continue;
    if (step >= 0) stack.push([set, step]);
    else {
      const sub = -1 - step;
      stack.push([sub, v], [set ^ sub, v]);
    }
  }
  return { nodes: [...fresh, ...allocationOrder(graph, anchors, chosen)], unreachable };
}

function bfs(adjacency: readonly number[][], starts: readonly number[]): {
  cost: Int32Array;
  parent: Int32Array;
} {
  const cost = new Int32Array(adjacency.length).fill(UNREACHED);
  const parent = new Int32Array(adjacency.length).fill(-1);
  const queue: number[] = [];
  for (const s of starts) {
    cost[s] = 0;
    queue.push(s);
  }
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head]!;
    for (const v of adjacency[u]!) {
      if (cost[v]! <= cost[u]! + 1) continue;
      cost[v] = cost[u]! + 1;
      parent[v] = u;
      queue.push(v);
    }
  }
  return { cost, parent };
}

/**
 * Shortest-path relaxation from many sources with different starting costs, on unit edges.
 *
 * The sources are visited in cost order and every relaxation adds exactly one, so a FIFO of
 * relaxed vertices stays sorted too; merging the two fronts is Dijkstra without a heap.
 */
function relax(adjacency: readonly number[][], cost: Int32Array, how: Int32Array): void {
  const sources: number[] = [];
  for (let v = 0; v < cost.length; v++) if (cost[v]! < UNREACHED) sources.push(v);
  sources.sort((a, b) => cost[a]! - cost[b]!);
  const queue: [number, number][] = [];
  let s = 0;
  let head = 0;
  while (s < sources.length || head < queue.length) {
    let u: number;
    let d: number;
    if (head >= queue.length || (s < sources.length && cost[sources[s]!]! <= queue[head]![1])) {
      u = sources[s++]!;
      d = cost[u]!;
    } else {
      [u, d] = queue[head++]!;
    }
    if (d !== cost[u]) continue;
    for (const v of adjacency[u]!) {
      if (cost[v]! <= d + 1) continue;
      cost[v] = d + 1;
      how[v] = u;
      queue.push([v, d + 1]);
    }
  }
}

function greedyRoute(
  graph: TreeGraph,
  anchors: ReadonlySet<NodeKey>,
  fresh: readonly NodeKey[],
  targets: readonly NodeKey[],
  first: NodeKey | undefined,
): Route {
  const held = new Set(anchors);
  const added = new Set<NodeKey>();
  const unreachable: NodeKey[] = [];
  let remaining = targets.filter((t) => !held.has(t));

  const take = (path: readonly NodeKey[]): void => {
    for (const key of path) {
      held.add(key);
      added.add(key);
    }
    remaining = remaining.filter((t) => !held.has(t));
  };

  if (first !== undefined && remaining.includes(first)) {
    const path = shortestPathTo(graph, held, first);
    if (path === undefined) {
      unreachable.push(first);
      remaining = remaining.filter((t) => t !== first);
    } else {
      take(path);
    }
  }

  while (remaining.length > 0) {
    let nearest: NodeKey[] | undefined;
    const blocked: NodeKey[] = [];
    for (const target of remaining) {
      const path = shortestPathTo(graph, held, target);
      if (path === undefined) blocked.push(target);
      else if (nearest === undefined || path.length < nearest.length) nearest = path;
    }
    unreachable.push(...blocked);
    remaining = remaining.filter((t) => !blocked.includes(t));
    if (nearest !== undefined) take(nearest);
  }

  const kept = pruneRoute(graph, anchors, added, new Set(targets));
  return { nodes: [...fresh, ...allocationOrder(graph, anchors, kept)], unreachable };
}

/**
 * Drops every added node the route can do without: not a target, and not holding anything
 * else to the anchors. Separate shortest paths can overlap into a loop, and a node on a loop
 * is a point spent twice.
 */
function pruneRoute(
  graph: TreeGraph,
  anchors: ReadonlySet<NodeKey>,
  added: ReadonlySet<NodeKey>,
  targets: ReadonlySet<NodeKey>,
): Set<NodeKey> {
  const kept = new Set(added);
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...kept].reverse()) {
      if (targets.has(key)) continue;
      kept.delete(key);
      if (allocationOrder(graph, anchors, kept).length === kept.size) {
        changed = true;
      } else {
        kept.add(key);
      }
    }
  }
  return kept;
}

/** The members of `route` reachable from `anchors` through `route`, in flood order. */
function allocationOrder(
  graph: TreeGraph,
  anchors: ReadonlySet<NodeKey>,
  route: ReadonlySet<NodeKey>,
): NodeKey[] {
  const seen = new Set<NodeKey>(anchors);
  const queue: NodeKey[] = [...anchors];
  const order: NodeKey[] = [];
  for (let head = 0; head < queue.length; head++) {
    for (const next of graph.neighbours(queue[head]!)) {
      if (seen.has(next) || !route.has(next)) continue;
      seen.add(next);
      queue.push(next);
      order.push(next);
    }
  }
  return order;
}

function tracePath(
  cameFrom: ReadonlyMap<NodeKey, NodeKey | undefined>,
  target: NodeKey,
  allocated: ReadonlySet<NodeKey>,
): NodeKey[] {
  const out: NodeKey[] = [];
  let cursor: NodeKey | undefined = target;
  while (cursor !== undefined) {
    if (!allocated.has(cursor)) out.push(cursor);
    cursor = cameFrom.get(cursor);
  }
  return out.reverse();
}
