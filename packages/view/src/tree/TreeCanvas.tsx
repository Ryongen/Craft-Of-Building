/**
 * The interactive tree surface: pan, zoom, hover, allocate.
 *
 * The canvas is imperative and the React state above it is not, so the transform lives in a ref
 * and drives its own animation frames. Putting it in state would rerender the whole panel on
 * every mouse-move of a drag.
 *
 * Clicking follows the game's rules rather than toggling a cell:
 *
 *   - a node with no allocated neighbour cannot be taken unless it is an entry perk
 *     (`TalentsData.canAllocate`), so the first click of a build has to be a class start;
 *   - clicking a distant node buys the cheapest route to it, which is what `cte2-planner`
 *     does and what makes a tree this size usable;
 *   - clicking an allocated node gives back everything that node was holding up
 *     (`TalentsData.hasPathToStart`), previewed before the click commits.
 */

import {
  CATEGORY,
  canAllocate,
  entry,
  nodeKey,
  orphansIfRemoved,
  shortestPathTo,
  type NodeKey,
  type TreeGraph,
} from "@cte2/schema";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useWorld } from "../world.js";

import { IconCache } from "./icons.js";
import { CELL, cellAtPoint, centreOn, draw, type NodeStatus, type Transform } from "./render.js";

const MIN_SCALE = 0.12;
const MAX_SCALE = 2.2;

const EMPTY: ReadonlySet<NodeKey> = new Set();

export type HoverInfo = {
  key: NodeKey;
  row: number;
  col: number;
  perkId: string;
  /** Screen position of the cursor, for placing the tooltip. */
  x: number;
  y: number;
  action: "allocate" | "deallocate" | "blocked";
  /** The nodes the click would add, or the branch it would take back. */
  affected: readonly NodeKey[];
  /** Set when a tap opened this rather than a hover, so a second tap on the node commits it. */
  touch?: boolean;
};

/** Finger movement allowed before a tap becomes a pan. Fingers wobble more than a mouse. */
const TOUCH_SLOP = 8;
/** How long after a touch the mouse events a browser emulates for it are ignored. */
const TOUCH_MOUSE_GUARD_MS = 800;

type TouchGesture =
  | { mode: "pan"; startX: number; startY: number; originX: number; originY: number; moved: boolean }
  | { mode: "pinch"; startDist: number; startMidX: number; startMidY: number; start: Transform };

export function TreeCanvas({
  graph,
  allocated,
  highlighted,
  onAllocate,
  onDeallocate,
  onHover,
  outline = EMPTY,
  marked = EMPTY,
  spotlight = null,
  focus,
}: {
  graph: TreeGraph;
  allocated: ReadonlySet<NodeKey>;
  highlighted: ReadonlySet<string>;
  onAllocate: (keys: readonly NodeKey[]) => void;
  onDeallocate: (keys: readonly NodeKey[]) => void;
  onHover: (info: HoverInfo | null) => void;
  /**
   * A route drawn as if it were being hovered — the drawer's ranked row or planned route. The
   * cursor's own preview wins while it is over a node, because that is the click about to happen.
   */
  outline?: ReadonlySet<NodeKey>;
  /** Route targets, ringed so they stand out from the path between them. */
  marked?: ReadonlySet<NodeKey>;
  /** The one node a list outside the canvas is pointing at right now. */
  spotlight?: NodeKey | null;
  /** Pans to `key`. `seq` changes per request, so asking twice for one node pans twice. */
  focus?: { key: NodeKey; seq: number } | undefined;
}): ReactNode {
  const world = useWorld();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef<Transform>({ x: 0, y: 0, scale: 0.55 });
  const frameRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<HoverInfo | null>(null);

  // Until a start is taken the game shows nothing else as clickable, so neither do we.
  const pickStart = useMemo(
    () => ![...allocated].some((key) => graph.nodes.get(key)?.perk?.isEntry === true),
    [allocated, graph],
  );

  const status = useCallback(
    (key: NodeKey): NodeStatus => {
      if (allocated.has(key)) return "connected";
      return canAllocate(graph, allocated, key) ? "possible" : "blocked";
    },
    [graph, allocated],
  );

  /** What clicking `key` would do, and to what. */
  const planFor = useCallback(
    (key: NodeKey): { action: HoverInfo["action"]; affected: readonly NodeKey[] } => {
      if (allocated.has(key)) {
        return { action: "deallocate", affected: [...orphansIfRemoved(graph, allocated, key)] };
      }
      // Refusing to path before a start exists mirrors the game's screen: `shortestPathTo`
      // would happily answer "buy this start on the way", but that is not a click the tree
      // ever offers.
      if (pickStart && graph.nodes.get(key)?.perk?.isEntry !== true) {
        return { action: "blocked", affected: [] };
      }
      const path = shortestPathTo(graph, allocated, key);
      if (path === undefined || path.length === 0) return { action: "blocked", affected: [] };
      return { action: "allocate", affected: path };
    },
    [graph, allocated, pickStart],
  );

  // `IconCache` holds every decoded texture for the life of a snapshot, and must not be
  // rebuilt when a callback identity changes — an earlier version keyed it on the redraw
  // callback, which threw away every decoded image on each click. The callback is reached
  // through a ref instead, so only a new snapshot replaces the cache.
  const redrawRef = useRef<() => void>(() => {});
  const iconsRef = useRef<IconCache | null>(null);
  if (iconsRef.current === null) {
    iconsRef.current = new IconCache((path) => world.icon(path), () => redrawRef.current());
  }
  useEffect(() => {
    iconsRef.current = new IconCache((path) => world.icon(path), () => redrawRef.current());
    redrawRef.current();
  }, [world]);

  const requestDraw = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const cache = iconsRef.current;
      draw(ctx, canvas.width, canvas.height, scaledFor(transformRef.current, canvas), {
        graph,
        texture: (path) => cache?.get(path) ?? null,
        allocated,
        status,
        pending:
          preview?.action === "allocate"
            ? new Set(preview.affected)
            : preview === null
              ? outline
              : EMPTY,
        doomed: preview?.action === "deallocate" ? new Set(preview.affected) : EMPTY,
        highlighted,
        hover: preview?.key ?? null,
        marked,
        spotlight,
        pickStart,
      });
    });
  }, [graph, allocated, status, preview, highlighted, pickStart, outline, marked, spotlight]);

  redrawRef.current = requestDraw;
  useEffect(() => requestDraw(), [requestDraw]);

  // Size the backing store to the device pixel ratio so nodes are not blurry.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const resize = (): void => {
      const ratio = window.devicePixelRatio || 1;
      const rect = wrap.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      redrawRef.current();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  // Start centred on `[CENTER]`. It is not where allocation begins — that is an entry perk —
  // but it is what the ring of class starts is arranged around, so it frames them.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const centre = graph.grid.center ?? [
      Math.floor(graph.grid.rows / 2),
      Math.floor(graph.grid.cols / 2),
    ];
    const rect = wrap.getBoundingClientRect();
    transformRef.current = centreOn(centre[0], centre[1], rect.width, rect.height, 0.55);
    redrawRef.current();
  }, [graph]);

  // Keeps the zoom the user chose; only the position moves.
  useEffect(() => {
    const wrap = wrapRef.current;
    const node = focus === undefined ? undefined : graph.nodes.get(focus.key);
    if (!wrap || node === undefined) return;
    const rect = wrap.getBoundingClientRect();
    transformRef.current = centreOn(node.row, node.col, rect.width, rect.height, transformRef.current.scale);
    redrawRef.current();
    // `focus` by identity is the request; `graph` changing under a stale request must not pan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  // Clearing the ref matters as much as cancelling the frame: `requestDraw` treats a non-null
  // `frameRef` as "a frame is already coming" and returns. StrictMode's mount/unmount/remount
  // cancels the very first frame, so leaving the id behind wedges the canvas blank forever —
  // every later redraw, including the ones hover and pan ask for, sees a frame that will never
  // run. Hit-testing keeps working the whole time, which is what makes it look like the tree
  // rendered nothing rather than that it stopped rendering.
  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, []);

  const pointerToLocal = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = wrapRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const dragState = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);

  const setHover = (info: HoverInfo | null): void => {
    setPreview(info);
    onHover(info);
  };

  // Touch runs beside the mouse handlers rather than through them, so the desktop path is the
  // one it always was. A touchscreen has no hover, so a tap previews a node and a second tap on
  // the same node commits it; one finger pans and two pinch-zoom.
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<TouchGesture | null>(null);
  const lastTouchRef = useRef(0);
  const touchedRecently = (): boolean => Date.now() - lastTouchRef.current < TOUCH_MOUSE_GUARD_MS;

  const beginTouchGesture = (): void => {
    const points = [...pointersRef.current.values()];
    const t = transformRef.current;
    if (points.length >= 2) {
      const [a, b] = points as [{ x: number; y: number }, { x: number; y: number }];
      gestureRef.current = {
        mode: "pinch",
        startDist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        startMidX: (a.x + b.x) / 2,
        startMidY: (a.y + b.y) / 2,
        start: t,
      };
    } else if (points.length === 1) {
      const [p] = points as [{ x: number; y: number }];
      // A finger left behind by a pinch pans from where it is, and is never a tap.
      const afterPinch = gestureRef.current?.mode === "pinch";
      gestureRef.current = {
        mode: "pan",
        startX: p.x,
        startY: p.y,
        originX: t.x,
        originY: t.y,
        moved: afterPinch,
      };
    } else {
      gestureRef.current = null;
    }
  };

  const tapAt = (clientX: number, clientY: number): void => {
    const { x, y } = pointerToLocal({ clientX, clientY });
    const { row, col } = cellAtPoint(transformRef.current, x, y);
    const key = nodeKey(row, col);
    const node = graph.nodes.get(key);
    if (node === undefined) {
      setHover(null);
      return;
    }
    const plan = planFor(key);
    if (preview?.key === key && preview.touch === true) {
      if (plan.action === "allocate") onAllocate(plan.affected);
      else if (plan.action === "deallocate") onDeallocate(plan.affected);
      setHover(null);
      return;
    }
    setHover({ key, row, col, perkId: node.perkId, x, y, ...plan, touch: true });
  };

  return (
    <div className="tree-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className={dragging ? "dragging" : ""}
        onWheel={(event) => {
          const { x, y } = pointerToLocal(event);
          const t = transformRef.current;
          const factor = Math.exp(-event.deltaY * 0.0016);
          const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, t.scale * factor));
          // Keep the world point under the cursor pinned while zooming.
          transformRef.current = {
            scale,
            x: x - ((x - t.x) / t.scale) * scale,
            y: y - ((y - t.y) / t.scale) * scale,
          };
          redrawRef.current();
        }}
        onMouseDown={(event) => {
          if (touchedRecently()) return;
          if (event.button !== 0) return;
          const t = transformRef.current;
          dragState.current = {
            startX: event.clientX,
            startY: event.clientY,
            originX: t.x,
            originY: t.y,
            moved: false,
          };
          setDragging(true);
        }}
        onMouseMove={(event) => {
          if (touchedRecently()) return;
          const drag = dragState.current;
          if (drag !== null) {
            const dx = event.clientX - drag.startX;
            const dy = event.clientY - drag.startY;
            // A few pixels of slop so a click with a shaky hand still counts as a click.
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
            transformRef.current = {
              ...transformRef.current,
              x: drag.originX + dx,
              y: drag.originY + dy,
            };
            redrawRef.current();
            return;
          }

          const { x, y } = pointerToLocal(event);
          const { row, col } = cellAtPoint(transformRef.current, x, y);
          const key = nodeKey(row, col);
          const node = graph.nodes.get(key);

          if (node === undefined) {
            if (preview !== null) setHover(null);
            return;
          }
          // Only recompute the plan when the node under the cursor changes; the plan is two
          // graph searches and the cursor moves every frame.
          if (preview?.key === key) return;

          const plan = planFor(key);
          setHover({ key, row, col, perkId: node.perkId, x, y, ...plan });
        }}
        onMouseUp={(event) => {
          if (touchedRecently()) return;
          const drag = dragState.current;
          dragState.current = null;
          setDragging(false);
          if (drag === null || drag.moved) return;

          const { x, y } = pointerToLocal(event);
          const { row, col } = cellAtPoint(transformRef.current, x, y);
          const key = nodeKey(row, col);
          if (!graph.nodes.has(key)) return;

          const plan = planFor(key);
          if (plan.action === "allocate") onAllocate(plan.affected);
          else if (plan.action === "deallocate") onDeallocate(plan.affected);
        }}
        onMouseLeave={() => {
          // A tap ends with the browser sending the emulated mouse back to wherever the real
          // one is, which would close the preview the tap just opened.
          if (touchedRecently()) return;
          dragState.current = null;
          setDragging(false);
          setHover(null);
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse") return;
          // Stops the browser emulating mousedown/mouseup for this touch, which would otherwise
          // run the desktop click path and allocate on the first tap.
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          lastTouchRef.current = Date.now();
          pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          beginTouchGesture();
        }}
        onPointerMove={(event) => {
          if (event.pointerType === "mouse") return;
          if (!pointersRef.current.has(event.pointerId)) return;
          lastTouchRef.current = Date.now();
          pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          const gesture = gestureRef.current;
          if (gesture === null) return;

          if (gesture.mode === "pinch") {
            const [a, b] = [...pointersRef.current.values()] as [
              { x: number; y: number },
              { x: number; y: number },
            ];
            const dist = Math.hypot(b.x - a.x, b.y - a.y);
            const rect = wrapRef.current!.getBoundingClientRect();
            const midX = (a.x + b.x) / 2 - rect.left;
            const midY = (a.y + b.y) / 2 - rect.top;
            const startX = gesture.startMidX - rect.left;
            const startY = gesture.startMidY - rect.top;
            const s = gesture.start;
            const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s.scale * (dist / gesture.startDist)));
            // The world point that was under the fingers' midpoint stays under it, and follows
            // it, so a pinch can pan and zoom at once.
            transformRef.current = {
              scale,
              x: midX - ((startX - s.x) / s.scale) * scale,
              y: midY - ((startY - s.y) / s.scale) * scale,
            };
            redrawRef.current();
            return;
          }

          const dx = event.clientX - gesture.startX;
          const dy = event.clientY - gesture.startY;
          if (Math.abs(dx) > TOUCH_SLOP || Math.abs(dy) > TOUCH_SLOP) gesture.moved = true;
          if (!gesture.moved) return;
          transformRef.current = {
            ...transformRef.current,
            x: gesture.originX + dx,
            y: gesture.originY + dy,
          };
          redrawRef.current();
        }}
        onPointerUp={(event) => {
          if (event.pointerType === "mouse") return;
          if (!pointersRef.current.delete(event.pointerId)) return;
          lastTouchRef.current = Date.now();
          const gesture = gestureRef.current;
          if (pointersRef.current.size === 0 && gesture?.mode === "pan" && !gesture.moved) {
            gestureRef.current = null;
            tapAt(event.clientX, event.clientY);
            return;
          }
          beginTouchGesture();
        }}
        onPointerCancel={(event) => {
          if (event.pointerType === "mouse") return;
          pointersRef.current.delete(event.pointerId);
          lastTouchRef.current = Date.now();
          if (pointersRef.current.size === 0) gestureRef.current = null;
          else beginTouchGesture();
        }}
      />
    </div>
  );
}

/** Device-pixel transform: the logical transform scaled by the backing-store ratio. */
function scaledFor(transform: Transform, canvas: HTMLCanvasElement): Transform {
  const ratio = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
  return { x: transform.x * ratio, y: transform.y * ratio, scale: transform.scale * ratio };
}

/** Exported for the panel's "fit" button. */
export function fitScale(graph: TreeGraph, width: number, height: number): number {
  return Math.min(width / (graph.grid.cols * CELL), height / (graph.grid.rows * CELL));
}

/** Reads a perk's raw registry data, for the hover tooltip. */
export function perkData(
  snapshot: Parameters<typeof entry>[0],
  perkId: string,
): Record<string, unknown> | undefined {
  return entry(snapshot, CATEGORY.perk, perkId)?.data;
}
