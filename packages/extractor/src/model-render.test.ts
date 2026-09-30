/**
 * The rule that keeps weapon icons from being UV sheets: a model with `elements` is drawn, never
 * reduced to its texture, and a flat item is left to the texture-reference path.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderItemModel, RENDER_SIZE } from "./model-render.js";
import { decodePng, encodePng } from "./png.js";

/** A 2x2 texture: red on the left column, blue on the right. */
function sheet(): Buffer {
  const data = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 0, 0, 255, 255]);
  return encodePng({ width: 2, height: 2, data });
}

test("png round-trips", () => {
  const image = decodePng(sheet());
  assert.ok(image);
  assert.equal(image.width, 2);
  assert.deepEqual([...image.data.subarray(4, 8)], [0, 0, 255, 255]);
});

test("a flat item model is left to the texture path", () => {
  const models = new Map([["mod:item/ring", { parent: "item/generated", textures: { layer0: "mod:item/ring" } }]]);
  assert.deepEqual(renderItemModel("mod:ring", models, new Map()), { kind: "flat" });
});

test("a block model is drawn through its parent, facing the viewer", () => {
  const models = new Map<string, Record<string, unknown>>([
    ["mod:item/club", { parent: "mod:custom/club", textures: { skin: "mod:block/club" } }],
    [
      "mod:custom/club",
      {
        // The left half of the slot, with the whole sheet mapped onto the face towards the viewer.
        elements: [{ from: [0, 0, 8], to: [8, 16, 8], faces: { south: { uv: [0, 0, 16, 16], texture: "#skin" } } }],
      },
    ],
  ]);
  const result = renderItemModel("mod:club", models, new Map([["mod:block/club", sheet()]]));
  assert.equal(result.kind, "model");
  const image = result.kind === "model" && result.png !== undefined ? decodePng(result.png) : undefined;
  assert.ok(image);
  assert.equal(image.width, RENDER_SIZE);

  const pixel = (x: number, y: number): number[] => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
  const mid = RENDER_SIZE / 2;
  // Left quarter samples the red column, the next the blue, the right half is empty.
  const left = pixel(mid / 4, mid);
  const right = pixel((mid * 3) / 4, mid);
  assert.ok(left[0]! > 0 && left[2] === 0);
  assert.ok(right[2]! > 0 && right[0] === 0);
  assert.equal(pixel(mid + mid / 2, mid)[3], 0);
});

test("a block model whose texture is missing is unresolved, not flat", () => {
  const models = new Map([
    ["mod:item/club", { elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { south: { texture: "#gone" } } }] }],
  ]);
  assert.deepEqual(renderItemModel("mod:club", models, new Map()), { kind: "model" });
});
