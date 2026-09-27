import { nodeKey, parseNodeKey, type BuildDoc, type NodeKey, type TreeCoord, type TreeKey } from "@cte2/schema";

import type { HoverInfo } from "./TreeCanvas.js";

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
 *
 * The drawer's ranking and route planner price whole paths through the same function, so a row
 * there and the tooltip over the same node are one number.
 */
export function candidateFor(
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
