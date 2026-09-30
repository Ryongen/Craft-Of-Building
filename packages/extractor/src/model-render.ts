/**
 * Draws a 3D item model the way the inventory does, for items that have no flat sprite.
 *
 * RoE Weapons, which supplies nearly every weapon in CTE2, ships each one as a Blockbench block
 * model: `elements` (cuboids) wearing a 32 or 64px texture *sheet*, turned to face the player by
 * the model's `display.gui` transform. The sheet is a UV layout, not a picture of the item, and
 * taking it as the icon is what made staves and totems look like unwrapped meshes and put a tiny
 * axe in one corner of the axe's sprite.
 *
 * So this does what the game's GUI item renderer does, in software: every face of every element,
 * through the element's own rotation, then `display.gui` (translate, rotate XYZ, scale about the
 * block centre), orthographic onto a 16-unit slot with Y flipped, back faces culled, a depth
 * buffer, and cutout alpha. Lighting is an approximation of the game's two-light GUI shading —
 * close enough that the sides read as sides, not a claim about exact pixel values.
 */

import { decodePng, encodePng, type Image } from "./png.js";

/** Pixels per side of the rendered sprite: four per GUI pixel, so 64px textures keep their detail. */
export const RENDER_SIZE = 64;

type Vec3 = [number, number, number];
type Json = Record<string, unknown>;

type Face = { uv?: number[]; texture?: string; rotation?: number };
type Element = {
  from: Vec3;
  to: Vec3;
  rotation?: { origin?: Vec3; axis?: string; angle?: number; rescale?: boolean };
  shade?: boolean;
  faces?: Record<string, Face>;
};

export type ModelRender =
  /** The chain has no `elements`: an ordinary flat item, for the texture-reference path. */
  | { kind: "flat" }
  /** A 3D model. `png` is absent when it could not be drawn, which must not fall back to its sheet. */
  | { kind: "model"; png?: Buffer };

/**
 * @param itemId `"roe_weapons:staff_0"`
 * @param models `<ns>:<path>` -> parsed model JSON, as `item-icons.ts` collects them
 * @param textures `<ns>:<path>` -> PNG bytes
 */
export function renderItemModel(
  itemId: string,
  models: ReadonlyMap<string, Json>,
  textures: ReadonlyMap<string, Buffer>,
): ModelRender {
  const colon = itemId.indexOf(":");
  let key = colon === -1 ? `minecraft:item/${itemId}` : `${itemId.slice(0, colon)}:item/${itemId.slice(colon + 1)}`;

  // Walk the chain child-first: the nearest model to declare each thing wins, as at bake time.
  const textureMap: Record<string, string> = {};
  let elements: Element[] | undefined;
  let gui: Json | undefined;
  let guiLight: string | undefined;
  const seen = new Set<string>();
  for (let depth = 0; depth < 8 && !seen.has(key); depth++) {
    seen.add(key);
    const model = models.get(key);
    if (model === undefined) break;
    const own = model["textures"];
    if (own !== null && typeof own === "object" && !Array.isArray(own)) {
      for (const [name, value] of Object.entries(own)) {
        if (typeof value === "string" && !(name in textureMap)) textureMap[name] = value;
      }
    }
    if (elements === undefined && Array.isArray(model["elements"])) elements = model["elements"] as Element[];
    const display = model["display"] as Json | undefined;
    if (gui === undefined && display !== null && typeof display === "object" && typeof display["gui"] === "object") {
      gui = display["gui"] as Json;
    }
    if (guiLight === undefined && typeof model["gui_light"] === "string") guiLight = model["gui_light"];
    const parent = model["parent"];
    if (typeof parent !== "string" || parent.length === 0) break;
    key = parent.includes(":") ? parent : `minecraft:${parent}`;
  }
  if (elements === undefined || elements.length === 0) return { kind: "flat" };

  const decoded = new Map<string, Image | undefined>();
  const textureFor = (reference: string | undefined): Image | undefined => {
    let ref = reference;
    for (let hops = 0; ref !== undefined && ref.startsWith("#") && hops < 8; hops++) ref = textureMap[ref.slice(1)];
    if (ref === undefined || ref.startsWith("#")) return undefined;
    const name = ref.includes(":") ? ref : `minecraft:${ref}`;
    if (!decoded.has(name)) {
      const bytes = textures.get(name);
      decoded.set(name, bytes === undefined ? undefined : decodePng(bytes));
    }
    return decoded.get(name);
  };

  const transform = guiTransform(gui);
  const size = RENDER_SIZE;
  const color = new Uint8Array(size * size * 4);
  const depthBuffer = new Float32Array(size * size).fill(-Infinity);
  let drawn = 0;

  for (const element of elements) {
    if (!Array.isArray(element.from) || !Array.isArray(element.to)) continue;
    const rotate = elementRotation(element.rotation);
    for (const [direction, face] of Object.entries(element.faces ?? {})) {
      const corners = FACE_CORNERS[direction];
      if (corners === undefined) continue;
      const texture = textureFor(face.texture);
      if (texture === undefined) continue;

      const normal = transform.normal(rotate.normal(FACE_NORMALS[direction]!));
      if (normal[2] <= 1e-6) continue; // facing away; the game culls these too

      const uv = face.uv ?? defaultUv(direction, element.from, element.to);
      const shift = (((face.rotation ?? 0) / 90) % 4 + 4) % 4;
      const vertices = corners.map((corner, i) => {
        const point: Vec3 = [
          corner[0] ? element.to[0] : element.from[0],
          corner[1] ? element.to[1] : element.from[1],
          corner[2] ? element.to[2] : element.from[2],
        ];
        const [x, y, z] = transform.point(rotate.point(point));
        const j = (i + shift) % 4;
        return {
          x: (8 + 16 * x) * (size / 16),
          y: (8 - 16 * y) * (size / 16),
          z,
          u: uv[j === 0 || j === 1 ? 0 : 2]!,
          v: uv[j === 0 || j === 3 ? 1 : 3]!,
        };
      });
      const shade = element.shade === false || guiLight === "front" ? 1 : lighting(normal);
      const bounds = {
        u0: Math.min(uv[0]!, uv[2]!),
        u1: Math.max(uv[0]!, uv[2]!),
        v0: Math.min(uv[1]!, uv[3]!),
        v1: Math.max(uv[1]!, uv[3]!),
      };
      for (const [a, b, c] of [
        [0, 1, 2],
        [0, 2, 3],
      ] as const) {
        drawn += fillTriangle(vertices[a]!, vertices[b]!, vertices[c]!, texture, bounds, shade, color, depthBuffer, size);
      }
    }
  }

  return drawn === 0 ? { kind: "model" } : { kind: "model", png: encodePng({ width: size, height: size, data: color }) };
}

/** The four corners of each face, as (x, y, z) picks of `to` (1) or `from` (0), in the game's vertex order. */
const FACE_CORNERS: Record<string, [number, number, number][]> = {
  down: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]],
  up: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  north: [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]],
  south: [[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]],
  west: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]],
  east: [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]],
};

const FACE_NORMALS: Record<string, Vec3> = {
  down: [0, -1, 0],
  up: [0, 1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0],
};

/** What the game fills in for a face that declares no `uv`: the element's extent on that face's plane. */
function defaultUv(direction: string, from: Vec3, to: Vec3): number[] {
  switch (direction) {
    case "down":
      return [from[0], 16 - to[2], to[0], 16 - from[2]];
    case "up":
      return [from[0], from[2], to[0], to[2]];
    case "north":
      return [16 - to[0], 16 - to[1], 16 - from[0], 16 - from[1]];
    case "south":
      return [from[0], 16 - to[1], to[0], 16 - from[1]];
    case "west":
      return [from[2], 16 - to[1], to[2], 16 - from[1]];
    default:
      return [16 - to[2], 16 - to[1], 16 - from[2], 16 - from[1]];
  }
}

/** An element's own rotation: one axis, about `origin`, optionally rescaled to keep its extent. */
function elementRotation(rotation: Element["rotation"]): { point: (p: Vec3) => Vec3; normal: (n: Vec3) => Vec3 } {
  const angle = ((rotation?.angle ?? 0) * Math.PI) / 180;
  if (rotation === undefined || angle === 0) return { point: (p) => p, normal: (n) => n };
  const axis = rotation.axis === "x" ? 0 : rotation.axis === "y" ? 1 : 2;
  const origin = rotation.origin ?? [8, 8, 8];
  const turn = (v: Vec3): Vec3 => rotateAxis(v, axis, angle);
  const rescale = rotation.rescale === true ? 1 / Math.cos(angle) : 1;
  return {
    point: (p) => {
      const r = turn([p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]]);
      return [0, 1, 2].map((i) => origin[i]! + (i === axis ? r[i]! : r[i]! * rescale)) as Vec3;
    },
    normal: turn,
  };
}

function rotateAxis(v: Vec3, axis: number, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  if (axis === 0) return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
  if (axis === 1) return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

/**
 * `display.gui` as the game applies it: centre the block on the origin, scale, rotate X then Y then
 * Z as JOML's `rotationXYZ` composes them, then translate (pixels, so / 16). Clamped as the game's
 * deserializer clamps.
 */
function guiTransform(gui: Json | undefined): { point: (p: Vec3) => Vec3; normal: (n: Vec3) => Vec3 } {
  const vec = (value: unknown, fallback: number): Vec3 =>
    Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number")
      ? (value as Vec3)
      : [fallback, fallback, fallback];
  const rotation = vec(gui?.["rotation"], 0).map((d) => (d * Math.PI) / 180) as Vec3;
  const translation = vec(gui?.["translation"], 0).map((t) => Math.max(-5, Math.min(5, t / 16))) as Vec3;
  const scale = vec(gui?.["scale"], 1).map((s) => Math.max(-4, Math.min(4, s))) as Vec3;

  const rotate = (v: Vec3): Vec3 =>
    rotateAxis(rotateAxis(rotateAxis(v, 2, rotation[2]), 1, rotation[1]), 0, rotation[0]);
  return {
    point: (p) => {
      const r = rotate([(p[0] / 16 - 0.5) * scale[0], (p[1] / 16 - 0.5) * scale[1], (p[2] / 16 - 0.5) * scale[2]]);
      return [r[0] + translation[0], r[1] + translation[1], r[2] + translation[2]];
    },
    normal: (n) => {
      // Normals take the inverse scale; a zero scale flattens the face, which then culls.
      const scaled = n.map((c, i) => (scale[i] === 0 ? 0 : c / scale[i]!)) as Vec3;
      const r = rotate(scaled);
      const length = Math.hypot(r[0], r[1], r[2]);
      return length === 0 ? [0, 0, 0] : [r[0] / length, r[1] / length, r[2] / length];
    },
  };
}

/** Two lights from the upper front, over an ambient floor, as the game's GUI item lighting is built. */
function lighting(n: Vec3): number {
  const lights: Vec3[] = [
    [-0.25, 0.55, 0.8],
    [0.35, 0.3, 0.88],
  ];
  let sum = 0;
  for (const l of lights) {
    const length = Math.hypot(...l);
    sum += Math.max(0, (n[0] * l[0] + n[1] * l[1] + n[2] * l[2]) / length);
  }
  return Math.min(1, 0.4 + 0.6 * sum);
}

type Vertex = { x: number; y: number; z: number; u: number; v: number };

/** Returns how many pixels it wrote. */
function fillTriangle(
  a: Vertex,
  b: Vertex,
  c: Vertex,
  texture: Image,
  bounds: { u0: number; u1: number; v0: number; v1: number },
  shade: number,
  color: Uint8Array,
  depth: Float32Array,
  size: number,
): number {
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(area) < 1e-9) return 0;
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(a.y, b.y, c.y)));

  // Clamp texel lookups to the face's own UV rectangle so an edge sample cannot bleed into the
  // neighbouring island on the sheet.
  const texX = (u: number): number => Math.floor((u / 16) * texture.width);
  const texY = (v: number): number => Math.floor((v / 16) * texture.height);
  const tx0 = Math.max(0, texX(bounds.u0));
  const tx1 = Math.min(texture.width - 1, Math.max(tx0, Math.ceil((bounds.u1 / 16) * texture.width) - 1));
  const ty0 = Math.max(0, texY(bounds.v0));
  const ty1 = Math.min(texture.height - 1, Math.max(ty0, Math.ceil((bounds.v1 / 16) * texture.height) - 1));

  let written = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) / area;
      const w1 = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * a.z + w1 * b.z + w2 * c.z;
      const index = y * size + x;
      if (z <= depth[index]!) continue;
      const tx = Math.min(tx1, Math.max(tx0, texX(w0 * a.u + w1 * b.u + w2 * c.u)));
      const ty = Math.min(ty1, Math.max(ty0, texY(w0 * a.v + w1 * b.v + w2 * c.v)));
      const t = (ty * texture.width + tx) * 4;
      if (texture.data[t + 3]! < 26) continue; // cutout, as the game's item render type discards
      depth[index] = z;
      color[index * 4] = Math.round(texture.data[t]! * shade);
      color[index * 4 + 1] = Math.round(texture.data[t + 1]! * shade);
      color[index * 4 + 2] = Math.round(texture.data[t + 2]! * shade);
      color[index * 4 + 3] = texture.data[t + 3]!;
      written++;
    }
  }
  return written;
}
