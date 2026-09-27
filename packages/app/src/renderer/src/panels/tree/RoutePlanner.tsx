/**
 * Pick the nodes you want; get the fewest points that takes all of them.
 *
 * `routeTo` in `@cte2/schema` does the work — an exact Steiner tree up to eight targets, a
 * greedy one past that — and is fast enough (tens of milliseconds on the talent tree) to rerun
 * on every change, so there is no "solve" button: the route on the canvas is always the answer
 * for the targets and allocation on screen.
 *
 * Targets are UI state, per tree, not part of the build. They are a question being asked of the
 * tree, and a saved build that remembered half-finished questions would be a strange file.
 */

import {
  perkName,
  routeTo,
  type NodeKey,
  type TreeGraph,
  type TreeKey,
  type TreeNode,
} from "@cte2/schema";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useWhatIf } from "../../state/compare.js";
import { useWorld } from "../../state/snapshot.js";
import { ComparisonBlock } from "../../ui/DeltaTable.js";
import { signed } from "../../ui/format.js";

import { candidateFor } from "./candidate.js";
import { mergedPerkLines } from "./perk-lines.js";

/** What the picker offers: the nodes people plan routes to. Flats are the route, not the goal. */
const PICKABLE = new Set(["MAJOR", "SPECIAL", "ASC", "START"]);

/** Picker rows shown at once; the search box is how you get past them. */
const PICKER_LIMIT = 60;

type View = "changes" | "stats";

export function RoutePlanner({
  tree,
  graph,
  allocated,
  targets,
  onTargets,
  pointsLeft,
  onPreview,
  onMarked,
  onSpotlight,
  onFocus,
}: {
  tree: TreeKey;
  graph: TreeGraph;
  allocated: ReadonlySet<NodeKey>;
  targets: readonly NodeKey[];
  onTargets: (targets: NodeKey[]) => void;
  /** Unspent points on this tree, or `undefined` when the budget is unknown. */
  pointsLeft: number | undefined;
  onPreview: (keys: ReadonlySet<NodeKey> | undefined) => void;
  /** Rings the targets on the canvas, so they stand out from the path joining them. */
  onMarked: (keys: ReadonlySet<NodeKey> | undefined) => void;
  /** The node the picker is pointing at, ringed larger still. */
  onSpotlight: (key: NodeKey | null) => void;
  onFocus: (key: NodeKey) => void;
}): ReactNode {
  const world = useWorld();
  const doc = useBuild((s) => s.doc);
  const allocateNodes = useBuild((s) => s.allocateNodes);
  const [view, setView] = useState<View>("changes");
  // The option under the cursor (or the arrow keys) in the target picker.
  const [hovered, setHovered] = useState<NodeKey | undefined>(undefined);

  const route = useMemo(() => routeTo(graph, allocated, targets), [graph, allocated, targets]);
  // What the route would become with the hovered option added. Drawn while you choose, so the
  // cost of a pick is on the tree before it is made.
  const tentative = useMemo(
    () => (hovered === undefined ? route : routeTo(graph, allocated, [...targets, hovered])),
    [hovered, route, graph, allocated, targets],
  );

  // The route stays drawn for as long as this tab is showing, not only under the cursor: it is
  // the answer, and the canvas is where it is read.
  useEffect(() => {
    onPreview(tentative.nodes.length > 0 ? new Set(tentative.nodes) : undefined);
  }, [tentative, onPreview]);
  useEffect(() => {
    onMarked(targets.length > 0 ? new Set(targets) : undefined);
  }, [targets, onMarked]);
  // Hovering an option also pans to it: a ring on a node off screen shows nothing.
  useEffect(() => {
    onSpotlight(hovered ?? null);
    if (hovered !== undefined) onFocus(hovered);
  }, [hovered, onSpotlight, onFocus]);
  useEffect(
    () => () => {
      onPreview(undefined);
      onMarked(undefined);
      onSpotlight(null);
    },
    [onPreview, onMarked, onSpotlight],
  );

  const candidate = useMemo(
    () => candidateFor(doc, tree, "allocate", route.nodes),
    [doc, tree, route.nodes],
  );
  const whatIf = useWhatIf(candidate);

  const level = doc.character.level;
  const gained = useMemo(
    () =>
      view === "stats"
        ? mergedPerkLines(
            world.snapshot,
            route.nodes.flatMap((key) => graph.nodes.get(key)?.perkId ?? []),
            level,
          )
        : [],
    [view, world.snapshot, route.nodes, graph, level],
  );

  const name = (key: NodeKey): string => {
    const node = graph.nodes.get(key);
    return node === undefined ? key : perkName(world.snapshot, node.perkId);
  };

  /** Why a target could not be routed, in the tree's own terms. */
  const whyUnreachable = (key: NodeKey): string => {
    const kind = graph.nodes.get(key)?.perk?.oneKind;
    if (kind !== undefined) {
      const rival =
        [...allocated].find((k) => k !== key && graph.nodes.get(k)?.perk?.oneKind === kind) ??
        targets.find(
          (k) => k !== key && !route.unreachable.includes(k) && graph.nodes.get(k)?.perk?.oneKind === kind,
        );
      if (rival !== undefined) {
        return `only one ${kind} perk may be taken, and ${name(rival)} ${allocated.has(rival) ? "is allocated" : "is already a target"}`;
      }
    }
    return "no legal route reaches it";
  };

  const over = pointsLeft !== undefined && route.nodes.length > pointsLeft;

  return (
    <div className="route-planner">
      <div className="row gap-4 route-targets">
        <TargetPicker
          graph={graph}
          exclude={new Set([...targets, ...allocated])}
          onPick={(key) => {
            setHovered(undefined);
            onTargets([...targets, key]);
          }}
          onHover={setHovered}
        />
        {targets.map((key) => (
          <span
            key={key}
            className={`route-chip${allocated.has(key) ? " held" : ""}${route.unreachable.includes(key) ? " blocked" : ""}`}
          >
            <button className="link" onClick={() => onFocus(key)} title="Find it on the tree">
              {name(key)}
            </button>
            {allocated.has(key) && <span className="faint"> ✓</span>}
            <button
              className="route-chip-x"
              aria-label={`Remove ${name(key)}`}
              onClick={() => onTargets(targets.filter((t) => t !== key))}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      {hovered !== undefined && (
        <div className="text-sm route-hint">
          <strong>{name(hovered)}</strong>{" "}
          {tentative.unreachable.includes(hovered) ? (
            <span className="down">can't be added: {whyUnreachable(hovered)}.</span>
          ) : (
            <span className="faint">
              would make the route {tentative.nodes.length} points (
              {signed(tentative.nodes.length - route.nodes.length)}).
            </span>
          )}
        </div>
      )}

      {targets.length === 0 ? (
        <div className="faint text-sm">
          Add the gamechangers or notables you want. The cheapest set of nodes that reaches all of
          them is drawn on the tree and updates as you add, remove or allocate. Point at an option
          in the list to see where it is and what it would add.
        </div>
      ) : (
        <>
          <div className="row gap-4 route-summary">
            <span>
              <strong className="num">{route.nodes.length}</strong>{" "}
              {route.nodes.length === 1 ? "point" : "points"}
              {pointsLeft !== undefined && (
                <span className={over ? "down" : "faint"}>
                  {" "}
                  · {pointsLeft} unspent
                  {over && `, ${route.nodes.length - pointsLeft} short`}
                </span>
              )}
            </span>
            <button
              className="primary"
              disabled={route.nodes.length === 0}
              onClick={() => allocateNodes(tree, route.nodes)}
            >
              Allocate route
            </button>
            <button onClick={() => onTargets([])}>Clear targets</button>
          </div>

          {route.unreachable.map((key) => (
            <div key={key} className="text-sm down">
              Can't reach {name(key)}: {whyUnreachable(key)}.
            </div>
          ))}

          {route.nodes.length > 0 && (
            <div className="route-delta">
              <div className="row gap-3 route-views">
                <button
                  className={view === "changes" ? "primary" : ""}
                  onClick={() => setView("changes")}
                >
                  Changes to the build
                </button>
                <button
                  className={view === "stats" ? "primary" : ""}
                  onClick={() => setView("stats")}
                >
                  Stats on the route
                </button>
              </div>

              {view === "changes" ? (
                whatIf === undefined ? (
                  <div className="faint text-sm">Recomputing the build with this route…</div>
                ) : (
                  // Every stat that moved, not the first eight: this is the one place the whole
                  // route's effect is laid out, and there is a scrollbar.
                  <ComparisonBlock
                    comparison={whatIf.click.comparison}
                    statLimit={Infinity}
                    emptyNote="This route moves no number this planner reports."
                  />
                )
              ) : (
                <>
                  <div className="faint text-sm">
                    Everything the {route.nodes.length} nodes grant, added together at level {level}.
                    "More" modifiers multiply, as they do in game.
                  </div>
                  {gained.length === 0 ? (
                    <div className="faint text-sm">These nodes grant no stats.</div>
                  ) : (
                    <div className="route-gained">
                      {gained.map((line, i) => (
                        <div
                          key={i}
                          className={`tt-line${line.good === false ? " cost" : line.good === undefined ? " neutral" : ""}`}
                        >
                          {line.text}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TargetPicker({
  graph,
  exclude,
  onPick,
  onHover,
}: {
  graph: TreeGraph;
  exclude: ReadonlySet<NodeKey>;
  onPick: (key: NodeKey) => void;
  /** The option pointed at by the mouse or the arrow keys, or `undefined` for none. */
  onHover: (key: NodeKey | undefined) => void;
}): ReactNode {
  const world = useWorld();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // -1 is "nothing pointed at", which is where typing leaves it: panning the tree on every
  // keystroke would throw the view around while the list is still narrowing.
  const [active, setActive] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocumentDown = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocumentDown);
    return () => document.removeEventListener("mousedown", onDocumentDown);
  }, [open]);

  // Gamechangers first, then notables, each alphabetical. A perk that appears more than once on
  // the tree gets its grid position, since "which one" is then the whole question.
  const options = useMemo(() => {
    const nodes = [...graph.nodes.values()].filter((n) => PICKABLE.has(n.perk?.type ?? ""));
    const counts = new Map<string, number>();
    for (const n of nodes) counts.set(n.perkId, (counts.get(n.perkId) ?? 0) + 1);
    const rankOf = (n: TreeNode): number => (n.perk?.type === "MAJOR" ? 0 : n.perk?.type === "SPECIAL" ? 1 : 2);
    return nodes
      .map((n) => ({
        node: n,
        label:
          perkName(world.snapshot, n.perkId) +
          ((counts.get(n.perkId) ?? 0) > 1 ? ` (${n.row}, ${n.col})` : ""),
      }))
      .sort((a, b) => rankOf(a.node) - rankOf(b.node) || a.label.localeCompare(b.label));
  }, [graph, world.snapshot]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return options
      .filter((o) => !exclude.has(o.node.key))
      .filter(
        (o) =>
          needle.length === 0 ||
          o.label.toLowerCase().includes(needle) ||
          o.node.perkId.toLowerCase().includes(needle),
      )
      .slice(0, PICKER_LIMIT);
  }, [options, exclude, query]);

  const pointed = open && active >= 0 ? shown[active]?.node.key : undefined;
  useEffect(() => onHover(pointed), [pointed, onHover]);

  // Keeps the arrow-key option in view as it moves past the list's edge.
  useEffect(() => {
    if (active < 0) return;
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (key: NodeKey): void => {
    onPick(key);
    setQuery("");
    setActive(-1);
  };

  return (
    <div className="picker route-picker" ref={wrapRef}>
      <input
        type="text"
        value={query}
        placeholder="Add a target…"
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(-1);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((i) => Math.max(0, Math.min(shown.length - 1, i + step)));
          }
          if (event.key === "Enter") {
            const choice = shown[active >= 0 ? active : 0];
            if (choice !== undefined) pick(choice.node.key);
          }
        }}
      />
      {open && (
        <div
          className="picker-list route-picker-list"
          ref={listRef}
          onMouseLeave={() => setActive(-1)}
        >
          {shown.length === 0 && <div className="picker-option faint">No match</div>}
          {shown.map((o, i) => (
            <div
              key={o.node.key}
              className={`picker-option${i === active ? " active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(event) => {
                // Keeps focus in the box, so several targets can be added in a row.
                event.preventDefault();
                pick(o.node.key);
              }}
            >
              <span className="ellipsis">{o.label}</span>
              {o.node.perk?.type === "MAJOR" && <span className="badge warn">GC</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
