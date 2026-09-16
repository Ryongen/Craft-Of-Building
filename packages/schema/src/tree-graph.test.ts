import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allocationBlock,
  canAllocate,
  hasPathToEntry,
  nodeKey,
  orphansIfRemoved,
  parseNodeKey,
  shortestPathTo,
  treeGraph,
  type NodeKey,
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

test("node keys round-trip", () => {
  assert.deepEqual(parseNodeKey(nodeKey(67, 90)), [67, 90]);
});
