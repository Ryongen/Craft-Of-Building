import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allocationBlock,
  canAllocate,
  hasPathToEntry,
  nodeKey,
  orphansIfRemoved,
  parseNodeKey,
  routeTo,
  shortestPathTo,
  treeGraph,
  type NodeKey,
  type TreeGraph,
} from "./tree-graph.js";
import { grid, makeSnapshot, standardSnapshot } from "./test-support.js";

const START = nodeKey(2, 2);
const ARMOR = nodeKey(2, 4);
const DODGE = nodeKey(2, 6);
const FAR = nodeKey(5, 2);
const START_B = nodeKey(5, 6);

function edgeBetween(a: NodeKey, b: NodeKey, snapshot = standardSnapshot()): boolean {
  return treeGraph(snapshot, "talents")!.neighbours(a).includes(b);
}

test("edges follow a single connector channel, and never run through a talent", () => {
  const graph = treeGraph(standardSnapshot(), "talents")!;

  assert.deepEqual([...graph.nodes.keys()].sort(), [START, ARMOR, DODGE, FAR, START_B].sort());

  // `start` reaches `armor_flat` along `o`; `far_perk` reaches it along `k`.
  assert.ok(edgeBetween(START, ARMOR));
  assert.ok(edgeBetween(FAR, ARMOR));
  assert.ok(edgeBetween(DODGE, ARMOR));

  // `dodge_flat` is two `o` cells past `armor_flat`, but the search stops at the first talent
  // it reaches, so `start` and `dodge_flat` are not neighbours.
  assert.ok(!edgeBetween(START, DODGE));
  // The `o` and `k` channels meet at `armor_flat` without joining to each other.
  assert.ok(!edgeBetween(START, FAR));
  // Nothing reaches the isolated second start.
  assert.deepEqual(graph.neighbours(START_B), []);

  // Every edge names the channel it ran on, and carries the cells it walked so the renderer
  // can draw the wire rather than a straight line.
  const startToArmor = graph.edges.find(
    (e) => (e.a === START && e.b === ARMOR) || (e.a === ARMOR && e.b === START),
  )!;
  assert.equal(startToArmor.glyph, "o");
  assert.deepEqual(startToArmor.path, [[2, 3]]);
});

test("the E border ring never produces an edge", () => {
  const graph = treeGraph(standardSnapshot(), "talents")!;
  // `E` classifies as a connector on channel "e", which is why it guards the array reads.
  // No talent sits beside one, so no edge is ever built on that channel.
  assert.deepEqual(
    graph.edges.filter((e) => e.glyph === "e"),
    [],
  );
});

test("a diagonal step that cuts past a talent is refused", () => {
  // Note the ring of empty cells inside the `E` border: a talent placed against the border
  // picks up "e" as a channel and can then walk the whole ring, which is real behaviour but
  // not what this test is about. The shipped grids never place a talent there.
  const snapshot = makeSnapshot({
    mmorpg_perk: {
      aaa: { id: "aaa", type: "STAT", is_entry: true, stats: [] },
      bbb: { id: "bbb", type: "STAT", stats: [] },
      wall: { id: "wall", type: "STAT", stats: [] },
    },
    mmorpg_talent_tree: {
      talents: grid([
        ["E", "E", "E", "E", "E", "E", "E"],
        ["E", "", "", "", "", "", "E"],
        ["E", "", "aaa", "o", "", "", "E"],
        ["E", "", "", "wall", "o", "", "E"],
        ["E", "", "", "", "bbb", "", "E"],
        ["E", "", "", "", "", "", "E"],
        ["E", "E", "E", "E", "E", "E", "E"],
      ]),
    },
  });
  const graph = treeGraph(snapshot, "talents")!;

  // The `o` at (2, 3) and the `o` at (3, 4) are diagonal neighbours, but the corner they cut
  // past at (3, 3) is `wall`, a talent — so the wire does not continue and `aaa` never
  // reaches `bbb`. Both still connect to `wall` itself, which is admitted as a talent.
  assert.ok(!graph.neighbours(nodeKey(2, 2)).includes(nodeKey(4, 4)));
  assert.ok(graph.neighbours(nodeKey(2, 2)).includes(nodeKey(3, 3)));
  assert.ok(graph.neighbours(nodeKey(4, 4)).includes(nodeKey(3, 3)));
});

test("no talent beside a connector means no edges at all", () => {
  // A row of adjacent talents. Adjacent talents are admitted by the search, but the search
  // only ever runs once per *connector channel* leaving the node — with no connector beside
  // it, `connectorTypes` is empty and the loop body never executes.
  const snapshot = makeSnapshot({
    mmorpg_perk: { aaa: { id: "aaa", type: "STAT", stats: [] } },
    mmorpg_talent_tree: { talents: grid([["aaa", "aaa", "aaa"]]) },
  });
  assert.deepEqual(treeGraph(snapshot, "talents")!.edges, []);
});

test("allocation needs an allocated neighbour unless the perk is an entry", () => {
  const graph = treeGraph(standardSnapshot(), "talents")!;
  const none = new Set<NodeKey>();

  assert.ok(canAllocate(graph, none, START));
  assert.ok(canAllocate(graph, none, START_B));
  assert.deepEqual(allocationBlock(graph, none, ARMOR), { reason: "not-connected" });

  const withStart = new Set([START]);
  assert.ok(canAllocate(graph, withStart, ARMOR));
  assert.deepEqual(allocationBlock(graph, withStart, DODGE), { reason: "not-connected" });
  assert.deepEqual(allocationBlock(graph, withStart, START_B), {
    reason: "one-kind",
    oneKind: "start",
    heldBy: "start",
  });
});

test("removing a node takes everything it orphans with it", () => {
  const graph = treeGraph(standardSnapshot(), "talents")!;
  const allocated = new Set([START, ARMOR, DODGE, FAR]);

  assert.ok(hasPathToEntry(graph, allocated, FAR));
  assert.ok(!hasPathToEntry(graph, allocated, FAR, ARMOR));

  // `armor_flat` is the only route to both `dodge_flat` and `far_perk`.
  assert.deepEqual([...orphansIfRemoved(graph, allocated, ARMOR)].sort(), [ARMOR, DODGE, FAR].sort());
  // A leaf takes nothing else.
  assert.deepEqual([...orphansIfRemoved(graph, allocated, DODGE)], [DODGE]);
  // Dropping the start orphans the entire tree.
  assert.equal(orphansIfRemoved(graph, allocated, START).size, 4);
});

test("the shortest route is the set of nodes that would have to be bought", () => {
  const graph = treeGraph(standardSnapshot(), "talents")!;

  // With nothing allocated the search seeds from the entry perks, so it answers "what would
  // this cost from scratch" — including the start it would have to buy on the way. The tree
  // UI still refuses to path anywhere until a start is chosen, mirroring the game's screen.
  assert.deepEqual(shortestPathTo(graph, new Set(), START), [START]);
  assert.deepEqual(shortestPathTo(graph, new Set(), DODGE), [START, ARMOR, DODGE]);

  const withStart = new Set([START]);
  assert.deepEqual(shortestPathTo(graph, withStart, DODGE), [ARMOR, DODGE]);
  assert.deepEqual(shortestPathTo(graph, withStart, START), []);
  // Blocked by one_kind rather than by distance: a second start can never be bought.
  assert.equal(shortestPathTo(graph, withStart, START_B), undefined);
  // Nothing reaches the isolated node except taking it as the start itself.
  assert.deepEqual(shortestPathTo(graph, new Set(), START_B), [START_B]);
});

/**
 * A graph straight from an adjacency list, for routing tests where drawing the grid would hide
 * the shape being tested. Only what the routing reads is filled in.
 */
function sketch(
  adjacency: Record<string, string[]>,
  perks: Record<string, { isEntry?: boolean; oneKind?: string }> = {},
): TreeGraph {
  const links = new Map<NodeKey, Set<NodeKey>>();
  const at = (key: NodeKey): Set<NodeKey> => {
    if (!links.has(key)) links.set(key, new Set());
    return links.get(key)!;
  };
  const link = (a: NodeKey, b: NodeKey): void => void at(a).add(b);
  for (const [a, bs] of Object.entries(adjacency)) {
    at(a);
    for (const b of bs) {
      link(a, b);
      link(b, a);
    }
  }
  const nodes = new Map(
    [...links.keys()].map((key) => [
      key,
      { key, row: 0, col: 0, perkId: key, perk: { ...perks[key] } },
    ]),
  );
  return {
    nodes,
    neighbours: (key: NodeKey) => [...(links.get(key) ?? [])],
    entries: [...nodes.values()].filter((n) => n.perk.isEntry === true),
  } as unknown as TreeGraph;
}

test("a route branches at a hub no target sits on", () => {
  // Each target is three points from the last along its own wire, and four through the hub.
  // Joining the nearest target each time never touches the hub and costs 9; branching at the
  // hub costs 8. Only a search that considers non-target branch points finds it.
  const graph = sketch({
    a: ["u1", "x1"],
    u1: ["u2"],
    u2: ["t2"],
    t2: ["v1"],
    v1: ["v2"],
    v2: ["t3"],
    t3: ["w1"],
    w1: ["w2"],
    w2: ["t4"],
    x1: ["c"],
    c: ["x2", "x3", "x4"],
    x2: ["t2"],
    x3: ["t3"],
    x4: ["t4"],
  });
  const route = routeTo(graph, new Set(["a"]), ["t2", "t3", "t4"]);

  assert.deepEqual(route.unreachable, []);
  assert.deepEqual([...route.nodes].sort(), ["c", "t2", "t3", "t4", "x1", "x2", "x3", "x4"]);
  // Front to back, every node touches something already held.
  const held = new Set(["a"]);
  for (const key of route.nodes) {
    assert.ok(graph.neighbours(key).some((n) => held.has(n)), `${key} is not connected`);
    held.add(key);
  }
});

test("a route leaves out a target that one_kind locks away", () => {
  const graph = sketch(
    { a: ["g1", "b"], b: ["g2", "t"] },
    { g1: { oneKind: "focus" }, g2: { oneKind: "focus" } },
  );
  const route = routeTo(graph, new Set(["a"]), ["g1", "g2", "t"]);

  assert.equal(route.unreachable.length, 1);
  assert.ok(["g1", "g2"].includes(route.unreachable[0]!));
  assert.ok(route.nodes.includes("t"));
  // Held already, the rival is simply unreachable.
  assert.deepEqual(routeTo(graph, new Set(["a", "g1"]), ["g2"]), { nodes: [], unreachable: ["g2"] });
});

test("from nothing, a route picks the start that suits its targets", () => {
  const graph = sketch(
    { s1: ["x"], x: ["y"], y: ["z"], s2: ["t"], z: ["t"] },
    { s1: { isEntry: true, oneKind: "start" }, s2: { isEntry: true, oneKind: "start" } },
  );
  assert.deepEqual(routeTo(graph, new Set(), ["t"]).nodes, ["s2", "t"]);
});

test("past the exact limit a route still reaches every target, legally ordered", () => {
  // A comb: a spine with a tooth off every node. Ten teeth is past the exact solver, so this
  // runs the greedy fallback — which happens to be optimal on a tree.
  const adjacency: Record<string, string[]> = { a: ["s0"] };
  const teeth: string[] = [];
  for (let i = 0; i < 10; i++) {
    adjacency[`s${i}`] = [`s${i + 1}`, `t${i}`];
    teeth.push(`t${i}`);
  }
  const graph = sketch(adjacency);
  const route = routeTo(graph, new Set(["a"]), teeth);

  assert.deepEqual(route.unreachable, []);
  assert.equal(route.nodes.length, 20);
  const held = new Set(["a"]);
  for (const key of route.nodes) {
    assert.ok(graph.neighbours(key).some((n) => held.has(n)), `${key} is not connected`);
    held.add(key);
  }
});

test("past the exact limit a route still finds a hub no target sits on", () => {
  // The hub from above, plus six cheap targets on their own spokes to push it past the exact
  // solver. Joining the nearest target each time chains t2-t3-t4 for 9; the hub does it in 8.
  const adjacency: Record<string, string[]> = {
    a: ["u1", "x1"],
    u1: ["u2"],
    u2: ["t2"],
    t2: ["v1"],
    v1: ["v2"],
    v2: ["t3"],
    t3: ["w1"],
    w1: ["w2"],
    w2: ["t4"],
    x1: ["c"],
    c: ["x2", "x3", "x4"],
    x2: ["t2"],
    x3: ["t3"],
    x4: ["t4"],
  };
  const spokes: string[] = [];
  for (let i = 0; i < 6; i++) {
    adjacency.a!.push(`p${i}`);
    adjacency[`p${i}`] = [`q${i}`];
    spokes.push(`q${i}`);
  }
  const graph = sketch(adjacency);
  const route = routeTo(graph, new Set(["a"]), [...spokes, "t2", "t3", "t4"]);

  assert.deepEqual(route.unreachable, []);
  assert.equal(route.nodes.length, 12 + 8);
  assert.ok(route.nodes.includes("c"));
});

test("targets already held, or not on the tree, cost nothing", () => {
  const graph = sketch({ a: ["b"] });
  assert.deepEqual(routeTo(graph, new Set(["a", "b"]), ["b"]), { nodes: [], unreachable: [] });
  assert.deepEqual(routeTo(graph, new Set(["a"]), ["nowhere"]), {
    nodes: [],
    unreachable: ["nowhere"],
  });
});

test("node keys round-trip", () => {
  assert.deepEqual(parseNodeKey(nodeKey(67, 90)), [67, 90]);
});
