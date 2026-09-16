/**
 * Drawing a talent tree, the way the game draws it.
 *
 * Layout is not a graph to lay out but a grid to map: cell `(row, col)` sits at
 * `(col * CELL, row * CELL)`. What *is* computed is the edge set, and it comes from
 * `treeGraph` in `@cte2/schema` — a port of the mod's own `TalentGrid` parser — rather than
 * from any inference here. An earlier version of this file guessed edges from grid adjacency
 * and said so; that guess was wrong, because a connector glyph is a channel id and a path may
 * only run along cells bearing the same letter.
 *
 * ## What the game actually draws, and what this mirrors
 *
 * From `SkillTreeScreen.renderConnection` and `PerkButton.renderWidget`:
 *
 *   - a connection is a **straight line between two perk centres**, rotated to the angle
 *     between them, drawn from `skill_connection.png` — three horizontal bands selected by
 *     `Perk.Connection`: LINKED at the top, POSSIBLE below it, BLOCKED below that;
 *   - a node is three stacked quads: the `indic/{yes,can,no}` status disc, then the
 *     `borders/<type>_{on,off}` frame, then the perk icon;
 *   - `PerkStatus` sets the opacity — CONNECTED and POSSIBLE at 1, BLOCKED at 0.5;
 *   - and while a school has nothing allocated, every non-entry perk drops to 0.2 so the only
 *     thing that reads as clickable is a start.
 *
 * `PerkType` also carries the pixel size of each node — STAT 24, SPECIAL 28, START 28,
 * MAJOR 33, ASC 56 — against a grid spacing of 26. Those are kept in proportion to `CELL`
 * rather than reinvented, which is why the big nodes overlap their cell slightly here too.
 *
 * Textures are drawn when loaded and fall back to vector shapes when they are not, so the
 * first frame after a snapshot loads is never blank.
 */

import type { NodeKey, TreeGraph } from "@cte2/schema";

/** World-space size of one grid cell at scale 1. */
export const CELL = 40;

/** `PerkButton.SPACING` — the game's grid pitch, which every node size is relative to. */
const GAME_SPACING = 26;

export type Transform = { x: number; y: number; scale: number };

/** `PerkStatus`. CONNECTED is allocated, POSSIBLE is one click away, BLOCKED is neither. */
export type NodeStatus = "connected" | "possible" | "blocked";

/** `Perk.Connection`. */
export type EdgeStatus = "linked" | "possible" | "blocked";

export type PerkStyle = {
  /** World-space diameter of the node's frame. */
  size: number;
  /** World-space size of the icon inside it. */
  iconSize: number;
  /** Texture stem under `skill_tree/borders/`. */
  border: string;
  /** Fallback vector shape: number of sides, 0 for a circle. */
  sides: number;
};

/** `Perk.PerkType`, with the pixel sizes scaled from the game's 26px pitch to ours. */
const PERK_STYLES: Record<string, PerkStyle> = {
  STAT: style(24, 16, "stat", 0),
  SPECIAL: style(28, 16, "special", 0),
  MAJOR: style(33, 16, "major", 6),
  START: style(28, 16, "start", 4),
  ASC: style(56, 32, "asc", 6),
};

function style(size: number, iconSize: number, border: string, sides: number): PerkStyle {
  const k = CELL / GAME_SPACING;
  return { size: size * k, iconSize: iconSize * k, border, sides };
}

const DEFAULT_STYLE = PERK_STYLES["STAT"]!;

export function perkStyle(type: string | undefined): PerkStyle {
  return (type === undefined ? undefined : PERK_STYLES[type]) ?? DEFAULT_STYLE;
}

const GUI = "mmorpg:textures/gui/skill_tree/";
const CONNECTION_TEXTURE = `${GUI}skill_connection.png`;

function borderTexture(style: PerkStyle, status: NodeStatus): string {
  return `${GUI}borders/${style.border}_${status === "connected" ? "on" : "off"}.png`;
}

function indicatorTexture(status: NodeStatus): string {
  const name = status === "connected" ? "yes" : status === "possible" ? "can" : "no";
  return `${GUI}indic/${name}.png`;
}

/**
 * Source bands in `skill_connection.png`. The game declares the texture as 50x16 and blits a
 * 6px band at v-offsets 0 / 6 / 11; the shipped file is 100x32, i.e. the same art at 2x. The
 * last band is clipped to stay inside the image, which the game's own blit does not bother to
 * do.
 */
const CONNECTION_BANDS: Record<EdgeStatus, { y: number; h: number }> = {
  linked: { y: 0, h: 10 },
  possible: { y: 12, h: 10 },
  blocked: { y: 22, h: 10 },
};

export type RenderInput = {
  graph: TreeGraph;
  /** Resource path -> a decoded image, or null when it is not loaded (or does not exist). */
  texture: (resourcePath: string) => HTMLImageElement | null;
  allocated: ReadonlySet<NodeKey>;
  status: (key: NodeKey) => NodeStatus;
  /** Nodes the hovered action would allocate. */
  pending: ReadonlySet<NodeKey>;
  /** Nodes the hovered action would remove. */
  doomed: ReadonlySet<NodeKey>;
  /** Perk ids matching the current search. Empty means no search is active. */
  highlighted: ReadonlySet<string>;
  hover: NodeKey | null;
  /**
   * True while this tree has no entry perk allocated. `PerkButton` dims everything but the
   * starts in that state, which is the whole of the game's "pick a class" UX.
   */
  pickStart: boolean;
};

const COLOURS = {
  background: "#12141a",
  center: "#d9b44a",
  node: "#3a4152",
  nodeEdge: "#4a5468",
  allocated: "#d9b44a",
  allocatedEdge: "#f0d47a",
  possibleEdge: "#7d8ba5",
  highlight: "#5b9dd9",
  hover: "#ffffff",
  pending: "#63c98a",
  doomed: "#d9534f",
  line: { linked: "#d9b44a", possible: "#5a6478", blocked: "#2f3646" },
};

const DIM_BLOCKED = 0.5;
const DIM_NOT_A_START = 0.2;
const DIM_NOT_SEARCHED = 0.25;

export function draw(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  transform: Transform,
  input: RenderInput,
): void {
  const { graph, allocated, highlighted, hover, pending, doomed } = input;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COLOURS.background;
  ctx.fillRect(0, 0, width, height);

  ctx.setTransform(transform.scale, 0, 0, transform.scale, transform.x, transform.y);

  // World-space viewport, padded by two cells so a node whose frame overhangs still draws.
  const left = -transform.x / transform.scale - CELL * 2;
  const top = -transform.y / transform.scale - CELL * 2;
  const right = left + width / transform.scale + CELL * 4;
  const bottom = top + height / transform.scale + CELL * 4;
  const visible = (x: number, y: number): boolean =>
    x >= left && x <= right && y >= top && y <= bottom;

  const centreOfNode = (key: NodeKey): { x: number; y: number } | undefined => {
    const node = graph.nodes.get(key);
    if (node === undefined) return undefined;
    return { x: node.col * CELL + CELL / 2, y: node.row * CELL + CELL / 2 };
  };

  // --- connections -------------------------------------------------------------------
  //
  // Drawn first so nodes sit on top, and in status order so a taken path is never buried
  // under a blocked one crossing it.
  const connectionImage = input.texture(CONNECTION_TEXTURE);
  const byStatus: Record<EdgeStatus, { a: { x: number; y: number }; b: { x: number; y: number } }[]> =
    { blocked: [], possible: [], linked: [] };

  for (const edge of graph.edges) {
    const a = centreOfNode(edge.a);
    const b = centreOfNode(edge.b);
    if (a === undefined || b === undefined) continue;
    if (!visible(a.x, a.y) && !visible(b.x, b.y)) continue;
    byStatus[edgeStatus(allocated, edge.a, edge.b)].push({ a, b });
  }

  for (const status of ["blocked", "possible", "linked"] as const) {
    const segments = byStatus[status];
    if (segments.length === 0) continue;

    if (connectionImage === null) {
      ctx.strokeStyle = COLOURS.line[status];
      ctx.lineCap = "round";
      ctx.lineWidth = status === "linked" ? 4 : 3;
      ctx.beginPath();
      for (const { a, b } of segments) {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      continue;
    }

    const band = CONNECTION_BANDS[status];
    for (const { a, b } of segments) {
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      ctx.save();
      ctx.translate(a.x, a.y);
      ctx.rotate(Math.atan2(b.y - a.y, b.x - a.x));
      ctx.drawImage(connectionImage, 0, band.y, connectionImage.width, band.h, 0, -4, length, 8);
      ctx.restore();
    }
  }

  // --- the centre marker -------------------------------------------------------------
  //
  // A camera origin, not an allocation anchor — but worth drawing, because it is where the
  // ring of class starts sits.
  const centre = graph.grid.center;
  if (centre !== undefined) {
    const cx = centre[1] * CELL + CELL / 2;
    const cy = centre[0] * CELL + CELL / 2;
    if (visible(cx, cy)) {
      ctx.strokeStyle = COLOURS.center;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, 14, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // --- nodes -------------------------------------------------------------------------
  const drawIcons = transform.scale > 0.45;
  const searching = highlighted.size > 0;

  for (const node of graph.nodes.values()) {
    const cx = node.col * CELL + CELL / 2;
    const cy = node.row * CELL + CELL / 2;
    if (!visible(cx, cy)) continue;

    const status = input.status(node.key);
    const isAllocated = status === "connected";
    const isPending = pending.has(node.key);
    const isDoomed = doomed.has(node.key);
    const isHighlighted = searching && highlighted.has(node.perkId);
    const isHover = hover === node.key;
    const nodeStyle = perkStyle(node.perk?.type);
    const isEntry = node.perk?.isEntry === true;

    // Opacity, in the game's own precedence: a search wins, then the "pick a start" state,
    // then the status.
    let alpha = status === "blocked" ? DIM_BLOCKED : 1;
    if (input.pickStart && !isEntry) alpha = DIM_NOT_A_START;
    if (searching) alpha = isHighlighted ? 1 : DIM_NOT_SEARCHED;
    ctx.globalAlpha = alpha;

    const half = nodeStyle.size / 2;
    const indicator = input.texture(indicatorTexture(status));
    const border = input.texture(borderTexture(nodeStyle, status));

    if (indicator !== null) {
      // The status disc is a fixed 20px in game, whatever the node's size.
      const discSize = 20 * (CELL / GAME_SPACING);
      ctx.drawImage(indicator, cx - discSize / 2, cy - discSize / 2, discSize, discSize);
    }
    if (border !== null) {
      ctx.drawImage(border, cx - half, cy - half, nodeStyle.size, nodeStyle.size);
    } else {
      // No texture yet: the vector node this file used to draw, so nothing pops in blank.
      ctx.beginPath();
      traceShape(ctx, cx, cy, nodeStyle);
      ctx.fillStyle = isAllocated ? COLOURS.allocated : COLOURS.node;
      ctx.fill();
      ctx.lineWidth = isAllocated ? 2.5 : 1.5;
      ctx.strokeStyle = isAllocated ? COLOURS.allocatedEdge : COLOURS.nodeEdge;
      ctx.stroke();
    }

    if (drawIcons) {
      const image = input.texture(node.perk?.icon ?? "");
      if (image !== null) {
        const size = nodeStyle.iconSize;
        ctx.drawImage(image, cx - size / 2, cy - size / 2, size, size);
      }
    }

    // Preview and focus rings, on top of everything and always at full opacity so a
    // pending path is legible even over dimmed nodes.
    const ring = isPending
      ? COLOURS.pending
      : isDoomed
        ? COLOURS.doomed
        : isHover
          ? COLOURS.hover
          : isHighlighted
            ? COLOURS.highlight
            : status === "possible" && !input.pickStart
              ? COLOURS.possibleEdge
              : null;

    if (ring !== null) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = ring;
      ctx.lineWidth = isPending || isDoomed || isHover ? 3 : 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, half + 2, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** `TalentsData.getConnection` — a line is live if either end is allocated, lit if both are. */
export function edgeStatus(
  allocated: ReadonlySet<NodeKey>,
  a: NodeKey,
  b: NodeKey,
): EdgeStatus {
  const hasA = allocated.has(a);
  const hasB = allocated.has(b);
  if (hasA && hasB) return "linked";
  return hasA || hasB ? "possible" : "blocked";
}

function traceShape(ctx: CanvasRenderingContext2D, cx: number, cy: number, style: PerkStyle): void {
  const radius = style.size / 2;
  if (style.sides === 0) {
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    return;
  }
  for (let i = 0; i < style.sides; i++) {
    // Start at -90 degrees so hexagons stand point-up and squares sit as diamonds.
    const angle = (Math.PI * 2 * i) / style.sides - Math.PI / 2;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Screen point -> grid cell. The inverse of the transform, then integer division. */
export function cellAtPoint(
  transform: Transform,
  screenX: number,
  screenY: number,
): { row: number; col: number } {
  const worldX = (screenX - transform.x) / transform.scale;
  const worldY = (screenY - transform.y) / transform.scale;
  return { row: Math.floor(worldY / CELL), col: Math.floor(worldX / CELL) };
}

/** A transform that centres `(row, col)` in a viewport of `width` x `height`. */
export function centreOn(
  row: number,
  col: number,
  width: number,
  height: number,
  scale: number,
): Transform {
  return {
    x: width / 2 - (col * CELL + CELL / 2) * scale,
    y: height / 2 - (row * CELL + CELL / 2) * scale,
    scale,
  };
}
