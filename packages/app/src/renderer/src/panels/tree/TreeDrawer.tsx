/**
 * The fold-out bar at the bottom of the tree: the ranked notables and the route planner.
 *
 * Closed, it is one row of tab buttons and costs nothing — the ranking prices hundreds of
 * documents, so it only exists while its tab is open. Open or closed is remembered like a card
 * fold, because someone who plans with it wants it there next time.
 */

import type { NodeKey, TreeGraph, TreeKey } from "@cte2/schema";
import { useState, type ReactNode } from "react";

import { usePanelOpen } from "../../ui/Panel.js";

import { NodeRanking } from "./NodeRanking.js";
import { RoutePlanner } from "./RoutePlanner.js";

type Tab = "rank" | "route";

/** One empty list for every render: a fresh `[]` would re-solve the route and redraw forever. */
const NO_TARGETS: NodeKey[] = [];

const TABS: { key: Tab; label: string }[] = [
  { key: "rank", label: "Best nodes" },
  { key: "route", label: "Route planner" },
];

export function TreeDrawer({
  tree,
  graph,
  allocated,
  pickStart,
  pointsLeft,
  onPreview,
  onMarked,
  onSpotlight,
  onFocus,
}: {
  tree: TreeKey;
  graph: TreeGraph;
  allocated: ReadonlySet<NodeKey>;
  /** No entry perk yet, so nothing has a path and there is nothing to rank or route. */
  pickStart: boolean;
  pointsLeft: number | undefined;
  onPreview: (keys: ReadonlySet<NodeKey> | undefined) => void;
  onMarked: (keys: ReadonlySet<NodeKey> | undefined) => void;
  onSpotlight: (key: NodeKey | null) => void;
  onFocus: (key: NodeKey) => void;
}): ReactNode {
  const [open, setOpen] = usePanelOpen("tree-drawer", false);
  const [tab, setTab] = useState<Tab>("rank");
  // Per tree, so switching to Ascendancy and back does not lose the talent targets.
  const [targets, setTargets] = useState<Partial<Record<TreeKey, NodeKey[]>>>({});

  const choose = (next: Tab): void => {
    if (open && tab === next) {
      setOpen(false);
      onPreview(undefined);
      return;
    }
    setTab(next);
    setOpen(true);
  };

  return (
    <div className={`tree-drawer tree-hud${open ? " open" : ""}`}>
      <div className="tree-drawer-bar row gap-3">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={open && tab === t.key ? "primary" : ""}
            onClick={() => choose(t.key)}
          >
            {t.label}
          </button>
        ))}
        <div className="grow" />
        <button
          className="tree-drawer-fold"
          onClick={() => {
            if (open) onPreview(undefined);
            setOpen(!open);
          }}
          aria-label={open ? "Fold the drawer" : "Open the drawer"}
          title={open ? "Fold" : "Open"}
        >
          {open ? "▾" : "▴"}
        </button>
      </div>

      {open && (
        <div className={`tree-drawer-body ${tab}`}>
          {pickStart ? (
            <div className="faint text-sm">Pick a start first; until then nothing has a path.</div>
          ) : tab === "rank" ? (
            <NodeRanking
              key={tree}
              tree={tree}
              graph={graph}
              allocated={allocated}
              onPreview={onPreview}
              onFocus={onFocus}
            />
          ) : (
            <RoutePlanner
              key={tree}
              tree={tree}
              graph={graph}
              allocated={allocated}
              targets={targets[tree] ?? NO_TARGETS}
              onTargets={(next) => setTargets((all) => ({ ...all, [tree]: next }))}
              pointsLeft={pointsLeft}
              onPreview={onPreview}
              onMarked={onMarked}
              onSpotlight={onSpotlight}
              onFocus={onFocus}
            />
          )}
        </div>
      )}
    </div>
  );
}
